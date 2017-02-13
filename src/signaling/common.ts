/**
 * Copyright (C) 2016-2017 Threema GmbH
 *
 * This software may be modified and distributed under the terms
 * of the MIT license.  See the `LICENSE.md` file for details.
 */

/// <reference path='../../saltyrtc-client.d.ts' />
/// <reference path='../types/tweetnacl.d.ts' />
/// <reference types='msgpack-lite' />

import * as msgpack from "msgpack-lite";
import { Box } from "../keystore";
import { Cookie } from "../cookie";
import { Nonce } from "../nonce";
import { ProtocolError, ValidationError } from "../exceptions";
import { SignalingError, ConnectionError } from "../exceptions";
import { concat, byteToHex, u8aToHex, arraysAreEqual } from "../utils";
import { isResponderId } from "./helpers";
import { HandoverState } from "./handoverstate";
import { CloseCode, explainCloseCode } from "../closecode";
import { Server, Peer, Responder, Initiator } from "../peers";

/**
 * Signaling base class.
 */
export abstract class Signaling implements saltyrtc.Signaling {
    static SALTYRTC_SUBPROTOCOL = 'v1.saltyrtc.org';
    static SALTYRTC_ADDR_UNKNOWN = 0x00;
    static SALTYRTC_ADDR_SERVER = 0x00;
    static SALTYRTC_ADDR_INITIATOR = 0x01;

    // WebSocket
    protected host: string;
    protected port: number;
    protected protocol: string = 'wss';
    protected ws: WebSocket = null;
    protected pingInterval: number;

    // Msgpack
    protected msgpackOptions: msgpack.BufferOptions = {
        codec: msgpack.createCodec({binarraybuffer: true}),
    };

    // Connection state
    protected state: saltyrtc.SignalingState = 'new';
    public handoverState = new HandoverState();

    // Main class
    protected client: saltyrtc.SaltyRTC;

    // Tasks
    protected tasks: saltyrtc.Task[];
    public task: saltyrtc.Task = null;

    // Server information
    protected server = new Server();

    // Our keys
    protected permanentKey: saltyrtc.KeyStore;
    protected sessionKey: saltyrtc.KeyStore = null;

    // Peer trusted key or auth token
    protected peerTrustedKey: Uint8Array = null;
    protected authToken: saltyrtc.AuthToken = null;

    // Server trusted key
    protected serverPublicKey: Uint8Array = null;

    // Signaling
    public role: saltyrtc.SignalingRole = null;
    protected logTag: string = 'Signaling:';
    protected address: number = Signaling.SALTYRTC_ADDR_UNKNOWN;

    /**
     * Create a new signaling instance.
     */
    constructor(client: saltyrtc.SaltyRTC, host: string, port: number, serverKey: Uint8Array,
                tasks: saltyrtc.Task[], pingInterval: number,
                permanentKey: saltyrtc.KeyStore, peerTrustedKey?: Uint8Array) {
        this.client = client;
        this.permanentKey = permanentKey;
        this.host = host;
        this.port = port;
        this.tasks = tasks;
        this.pingInterval = pingInterval;
        if (peerTrustedKey !== undefined) {
            this.peerTrustedKey = peerTrustedKey;
        }
        if (serverKey !== undefined) {
            this.serverPublicKey = serverKey;
        }
        this.handoverState.onBoth = () => {
            this.client.emit({type: 'handover'});
            this.ws.close(CloseCode.Handover);
        };
    }

    /**
     * Register a signaling state change.
     */
    public setState(newState: saltyrtc.SignalingState): void {
        this.state = newState;

        // Notify listeners
        this.client.emit({type: 'state-change', data: newState});
        this.client.emit({type: 'state-change:' + newState});
    }

    /**
     * Return current state.
     */
    public getState(): saltyrtc.SignalingState {
        return this.state;
    }

    /**
     * Return the public permanent key as Uint8Array.
     */
    public get permanentKeyBytes(): Uint8Array {
        return this.permanentKey.publicKeyBytes;
    }

    /**
     * Return the auth token as Uint8Array, or null if no auth token is initialized.
     */
    public get authTokenBytes(): Uint8Array {
        if (this.authToken !== null) {
            return this.authToken.keyBytes;
        }
        return null;
    }

    /**
     * Return the peer permanent key as Uint8Array.
     */
    public get peerPermanentKeyBytes(): Uint8Array {
        return this.getPeerPermanentKey();
    }

    /**
     * Encode msgpack data.
     */
    protected msgpackEncode(data: Object) {
        return msgpack.encode(data, this.msgpackOptions);
    }

    /**
     * Decode msgpack data.
     */
    protected msgpackDecode(data: Uint8Array) {
        return msgpack.decode(data, this.msgpackOptions);
    }

    /**
     * Open a connection to the signaling server and do the handshake.
     */
    public connect(): void {
        this.resetConnection();
        this.initWebsocket();
    }

    /**
     * Disconnect from the signaling server.
     */
    public disconnect(): void {
        const reason = CloseCode.ClosingNormal;

        // Update state
        this.setState('closing');

        // Send close message if necessary
        if (this.state === 'task') {
            this.sendClose(reason);
        }

        // Close WebSocket instance
        if (this.ws !== null) {
            console.debug(this.logTag, 'Disconnecting WebSocket');
            this.ws.close(reason);
        }
        this.ws = null;

        // Close task connections
        if (this.task !== null) {
            console.debug(this.logTag, 'Closing task connections');
            this.task.close(reason);
        }

        // Update state
        this.setState('closed');
    }

    /**
     * Return connection path for websocket.
     */
    protected abstract getWebsocketPath(): string;

    /**
     * Open a new WebSocket connection to the signaling server.
     */
    protected initWebsocket() {
        const url = this.protocol + '://' + this.host + ':' + this.port + '/';
        const path = this.getWebsocketPath();
        this.ws = new WebSocket(url + path, Signaling.SALTYRTC_SUBPROTOCOL);

        // Set binary type
        this.ws.binaryType = 'arraybuffer';

        // Set event handlers
        this.ws.addEventListener('open', this.onOpen);
        this.ws.addEventListener('error', this.onError);
        this.ws.addEventListener('close', this.onClose);
        this.ws.addEventListener('message', this.onMessage);

        // Store connection on instance
        this.setState('ws-connecting');
        console.debug(this.logTag, 'Opening WebSocket connection to', url + path);
    }

    /**
     * WebSocket onopen handler.
     */
    protected onOpen = (ev: Event) => {
        console.info(this.logTag, 'Opened connection');
        this.setState('server-handshake');
    };

    /**
     * WebSocket onerror handler.
     */
    protected onError = (ev: ErrorEvent) => {
        console.error(this.logTag, 'General WebSocket error', ev);
        this.client.emit({type: 'connection-error'});
        // Note: We don't update the state here, because an error event will be followed
        // by a close event, which is already handled in `onClose`.
    };

    /**
     * WebSocket onclose handler.
     */
    protected onClose = (ev: CloseEvent) => {
        if (ev.code === CloseCode.Handover) {
            console.info(this.logTag, 'Closed WebSocket connection due to handover');
        } else {
            console.info(this.logTag, 'Closed WebSocket connection');
            this.setState('closed');
            this.client.emit({type: 'connection-closed', data: ev.code});
            const log = (reason) => console.error(this.logTag, 'Websocket close reason:', reason);
            switch (ev.code) {
                case CloseCode.GoingAway:
                    log('Server is being shut down');
                    break;
                case CloseCode.NoSharedSubprotocol:
                    log('No shared sub-protocol could be found');
                    break;
                case CloseCode.PathFull:
                    log('Path full (no free responder byte)');
                    break;
                case CloseCode.ProtocolError:
                    log('Protocol error');
                    break;
                case CloseCode.InternalError:
                    log('Internal server error');
                    break;
                case CloseCode.DroppedByInitiator:
                    log('Dropped by initiator');
                    break;
                case CloseCode.InvalidKey:
                    log('Invalid server key');
                    break;
            }
        }
    };

    protected onMessage = (ev: MessageEvent) => {
        console.debug(this.logTag, 'New ws message (' + (ev.data as ArrayBuffer).byteLength + ' bytes)');

        if (this.handoverState.peer) {
            console.error(this.logTag, 'Protocol error: Received WebSocket message from peer ' +
                'even though it has already handed over to task.');
            this.resetConnection(CloseCode.ProtocolError);
            return;
        }

        let nonce: Nonce;
        try {
            // Parse buffer
            const box: saltyrtc.Box = Box.fromUint8Array(new Uint8Array(ev.data), Nonce.TOTAL_LENGTH);

            // Parse and validate nonce
            nonce = Nonce.fromArrayBuffer(box.nonce.buffer);
            try {
                this.validateNonce(nonce);
            } catch (e) {
                if (e.name === 'ValidationError') {
                    throw new ProtocolError('Invalid nonce: ' + e);
                } else {
                    throw e;
                }
            }

            // Dispatch message
            switch (this.getState()) {
                case 'server-handshake':
                    this.onServerHandshakeMessage(box, nonce);
                    break;
                case 'peer-handshake':
                    this.onPeerHandshakeMessage(box, nonce);
                    break;
                case 'task':
                    this.onSignalingMessage(box, nonce);
                    break;
                default:
                    console.warn(this.logTag, 'Received message in', this.getState(), 'signaling state. Ignoring.');
            }
        } catch(e) {
            if (e.name === 'SignalingError' || e.name === 'ProtocolError') {
                let errmsg = 'Signaling error: ' + explainCloseCode(e.closeCode);
                if (e.message) {
                    errmsg += ' (' + e.message + ')';
                }
                console.error(this.logTag, errmsg);
                switch (this.state) {
                    //'new' | 'ws-connecting' | 'server-handshake' | 'peer-handshake' | 'task' | 'closing' | 'closed';
                    case 'new':
                    case 'ws-connecting':
                    case 'server-handshake':
                        this.resetConnection(e.closeCode);
                        break;
                    case 'peer-handshake':
                        this.handlePeerHandshakeSignalingError(e, nonce === undefined ? null : nonce.source);
                        break;
                    case 'task':
                        this.sendClose(e.closeCode);
                        this.resetConnection(CloseCode.ClosingNormal);
                        break;
                    case 'closing':
                    case 'closed':
                        // Ignore
                        break;
                }
            } else if (e.name === 'ConnectionError') {
                console.warn(this.logTag, 'Connection error. Resetting connection.');
                this.resetConnection(CloseCode.InternalError);
            } else {
                if (e.hasOwnProperty('stack')) {
                    console.error("An unknown error occurred:");
                    console.error(e.stack);
                }
                throw e;
            }
        }
    };

    protected abstract handlePeerHandshakeSignalingError(e: SignalingError, source: number | null): void;

    /**
     * Handle messages received during server handshake.
     *
     * @throws SignalingError
     */
    protected onServerHandshakeMessage(box: saltyrtc.Box, nonce: Nonce): void {
        // Decrypt if necessary
        let payload: Uint8Array;
        if (this.server.handshakeState === 'new') {
            // The very first message is unencrypted
            payload = box.data;
        } else {
            // Later, they're encrypted with our permanent key and the server key
            payload = this.permanentKey.decrypt(box, this.server.sessionKey);
        }

        // Handle message
        const msg: saltyrtc.Message = this.decodeMessage(payload, 'server handshake');
        switch (this.server.handshakeState) {
            case 'new':
                // Expect server-hello
                if (msg.type !== 'server-hello') {
                    throw new ProtocolError('Expected server-hello message, but got ' + msg.type);
                }
                console.debug(this.logTag, 'Received server-hello');
                this.handleServerHello(msg as saltyrtc.messages.ServerHello, nonce);
                this.sendClientHello();
                this.sendClientAuth();
                break;
            case 'hello-sent':
                throw new ProtocolError('Received ' + msg.type + ' message before sending client-auth');
            case 'auth-sent':
                // Expect server-auth
                if (msg.type !== 'server-auth') {
                    throw new ProtocolError('Expected server-auth message, but got ' + msg.type);
                }
                console.debug(this.logTag, "Received server-auth");
                this.handleServerAuth(msg as saltyrtc.messages.ServerAuth, nonce);
                break;
            case 'done':
                throw new SignalingError(CloseCode.InternalError,
                    'Received server handshake message even though server handshake state is set to \'done\'');
            default:
                throw new SignalingError(CloseCode.InternalError,
                    'Unknown server handshake state: ' + this.server.handshakeState);
        }

        // Check if we're done yet
        if (this.server.handshakeState as string === 'done') {
            this.setState('peer-handshake');
            console.debug(this.logTag, 'Server handshake done');
            this.initPeerHandshake();
        }
    }

    /**
     * Handle messages received during peer handshake.
     */
    protected abstract onPeerHandshakeMessage(box: saltyrtc.Box, nonce: Nonce): void;

    /**
     * Handle messages received from peer *after* the handshake is done.
     */
    protected onSignalingMessage(box: saltyrtc.Box, nonce: Nonce): void {
        console.debug('Message received');
        if (nonce.source === Signaling.SALTYRTC_ADDR_SERVER) {
            this.onSignalingServerMessage(box);
        } else {
            let decrypted: Uint8Array = this.sessionKey.decrypt(box, this.getPeerSessionKey());
            this.onSignalingPeerMessage(decrypted);
        }
    }

    protected onSignalingServerMessage(box: saltyrtc.Box): void {
        const msg: saltyrtc.Message = this.decryptServerMessage(box);

        if (msg.type === 'send-error') {
            this.handleSendError(msg as saltyrtc.messages.SendError);
        } else {
            console.warn(this.logTag, 'Invalid server message type:', msg.type);
        }
    }

    /**
     * Signaling message received from peer *after* the handshake is done.
     *
     * @param decrypted Decrypted bytes from the peer.
     * @throws SignalingError if the message is invalid.
     */
    public onSignalingPeerMessage(decrypted: Uint8Array): void {
        let msg: saltyrtc.Message = this.decodeMessage(decrypted);

        if (msg.type === 'close') {
            console.debug('Received close');
            this.handleClose(msg as saltyrtc.messages.Close);
        } else if (msg.type === 'application') {
            console.debug(this.logTag, 'Received application message');
            this.handleApplication(msg as saltyrtc.messages.Application);
        } else if (this.task !== null && this.task.getSupportedMessageTypes().indexOf(msg.type) !== -1) {
            console.debug(this.logTag, 'Received', msg.type, '[' + this.task.getName() + ']');
            this.task.onTaskMessage(msg as saltyrtc.messages.TaskMessage);
        } else {
            console.warn(this.logTag, 'Received message with invalid type from peer:', msg.type);
        }
    }

    /**
     * Handle an incoming server-hello message.
     */
    protected handleServerHello(msg: saltyrtc.messages.ServerHello, nonce: Nonce): void {
        // Update server instance
        this.server.sessionKey = new Uint8Array(msg.key);
        this.server.cookiePair.theirs = nonce.cookie;
    }

    /**
     * Send a client-hello message to the server.
     */
    protected abstract sendClientHello(): void;

    /**
     * Send a client-auth message to the server.
     */
    protected sendClientAuth(): void {
        let message: saltyrtc.messages.ClientAuth = {
            type: 'client-auth',
            your_cookie: this.server.cookiePair.theirs.asArrayBuffer(),
            subprotocols: [Signaling.SALTYRTC_SUBPROTOCOL],
            ping_interval: this.pingInterval,
        };
        if (this.serverPublicKey !== null) {
            const start = this.serverPublicKey.byteOffset;
            const end = start + this.serverPublicKey.byteLength;
            message.your_key = this.serverPublicKey.buffer.slice(start, end);
        }
        const packet: Uint8Array = this.buildPacket(message, this.server);
        console.debug(this.logTag, 'Sending client-auth');
        this.ws.send(packet);
        this.server.handshakeState = 'auth-sent';
    }

    /**
     * Handle an incoming server-auth message.
     */
    protected abstract handleServerAuth(msg: saltyrtc.messages.ServerAuth, nonce: Nonce): void;

    /**
     * Initialize the peer handshake.
     */
    protected abstract initPeerHandshake(): void;

    /**
     * Handle an incoming send-error message.
     */
    protected handleSendError(msg: saltyrtc.messages.SendError): void {
        // Get the message id from the send-error message
        const id: DataView = new DataView(msg.id);
        const idString: string = u8aToHex(new Uint8Array(msg.id));

        // Determine the sender and receiver of the message
        const source = id.getUint8(0);
        const destination = id.getUint8(1);

        // Validate source
        if (source != this.address) {
            throw new ProtocolError("Received send-error message for a message not sent by us!");
        }

        // TODO: Log info about actual message (#62)
        console.warn(this.logTag, "SendError: Could not send unknown message:", idString);

        this._handleSendError(destination);
    }

    protected abstract _handleSendError(receiver: number): void;

    /**
     * Handle an incoming application message.
     */
    protected handleApplication(msg: saltyrtc.messages.Application): void {
        this.client.emit({type: 'application', data: msg.data});
    }

    /**
     * Send a close message to the peer.
     */
    public sendClose(reason: number): void {
        const message: saltyrtc.messages.Close = {
            type: 'close',
            reason: reason,
        };
        console.debug(this.logTag, 'Sending close');
        if (this.handoverState.local === true) {
            this.task.sendSignalingMessage(this.msgpackEncode(message));
        } else {
            const packet: Uint8Array = this.buildPacket(message, this.getPeer());
            this.ws.send(packet);
        }
    }

    /**
     * Handle an incoming close message.
     */
    protected handleClose(msg: saltyrtc.messages.Close): void {
        console.warn(this.logTag, 'Received close message. Reason:',
            msg.reason, '(' + explainCloseCode(msg.reason) + ')');

        // Notify the task
        this.task.close(msg.reason);

        // Reset signaling
        this.resetConnection(CloseCode.GoingAway);
    }

    /**
     * Validate the nonce.
     *
     * Throw ValidationError if validation fails.
     */
    protected validateNonce(nonce: Nonce): void {
        this.validateNonceSource(nonce);
        this.validateNonceDestination(nonce);
        this.validateNonceCsn(nonce);
        this.validateNonceCookie(nonce);
    }

    /**
     * Validate the nonce source.
     */
    private validateNonceSource(nonce: Nonce): void {
        switch (this.state) {
            case 'server-handshake':
                // Messages during server handshake must come from the server.
                if (nonce.source !== Signaling.SALTYRTC_ADDR_SERVER) {
                    throw new ValidationError("Received message during server handshake " +
                        "with invalid sender address (" + nonce.source + " != " + Signaling.SALTYRTC_ADDR_SERVER + ")");
                }
                break;
            case 'peer-handshake':
                // Messages during peer handshake may come from server or peer.
                if (nonce.source !== Signaling.SALTYRTC_ADDR_SERVER) {
                    if (this.role === 'initiator' && !isResponderId(nonce.source)) {
                        throw new ValidationError("Initiator peer message does not come from " +
                            "a valid responder address: " + nonce.source);
                    } else if (this.role === 'responder' && nonce.source != Signaling.SALTYRTC_ADDR_INITIATOR) {
                        throw new ValidationError("Responder peer message does not come from " +
                            "intitiator (" + Signaling.SALTYRTC_ADDR_INITIATOR + "), " +
                            "but from " + nonce.source);
                    }
                }
                break;
            case 'task':
                // Messages after the handshake must come from the peer.
                if (nonce.source !== this.getPeer().id) {
                    throw new ValidationError("Received message after handshake with invalid sender address (" +
                        nonce.source + " != " + this.getPeer().id + ")");
                }
                break;
            default:
                throw new ProtocolError('Cannot validate message nonce in signaling state ' + this.state);
        }
    }

    /**
     * Validate the nonce destination.
     */
    private validateNonceDestination(nonce: Nonce): void {
        let expected: number = null;
        if (this.state === 'server-handshake') {
            switch (this.server.handshakeState) {
                // Before receiving the server auth message, the destination is 0x00
                case 'new':
                case 'hello-sent':
                    expected = Signaling.SALTYRTC_ADDR_UNKNOWN;
                    break;
                // The server auth message contains the assigned receiver byte for the first time
                case 'auth-sent':
                    if (this.role === 'initiator') {
                        expected = Signaling.SALTYRTC_ADDR_INITIATOR;
                    } else { // Responder
                        if (!isResponderId(nonce.destination)) {
                            throw new ValidationError("Received message during server handshake with invalid " +
                                "receiver address (" + nonce.destination + " is not a valid responder id)");
                        }
                    }
                    break;
                // Afterwards, the receiver byte is the assigned address
                case 'done':
                    expected = this.address;
                    break;
            }
        } else if (this.state === 'peer-handshake' || this.state === 'task') {
            expected = this.address;
        } else {
            throw new ValidationError("Cannot validate message nonce in signaling state " + this.state);
        }

        if (expected !== null && nonce.destination !== expected) {
            throw new ValidationError("Received message with invalid destination (" +
                nonce.destination + " != " + expected + ")");
        }
    }

    /**
     * Return the peer instance with the specified id.
     *
     * In the case of the initiator, the peer can be one of multiple responders!
     */
    protected abstract getPeerWithId(id: number): Peer | null;

    /**
     * Validate the nonce CSN.
     */
    protected validateNonceCsn(nonce: Nonce): void {
        const peer = this.getPeerWithId(nonce.source);
        if (peer === null) {
            // This can happen e.g. when a responder was dropped between validating the source
            // and the csn.
            throw new ProtocolError("Could not find peer " + nonce.source);
        }

        // If this is the first message from that sender, validate the overflow number and store the CSN.
        if (peer.csnPair.theirs === null) {
            if (nonce.overflow !== 0) {
                throw new ValidationError("First message from " + peer.name + " must have set the overflow number to 0");
            }
            peer.csnPair.theirs = nonce.combinedSequenceNumber;

        // Otherwise, make sure that the CSN has been increased.
        } else {
            const previous = peer.csnPair.theirs;
            const current = nonce.combinedSequenceNumber;
            if (current < previous) {
                throw new ValidationError(peer.name + " CSN is lower than last time");
            } else if (current === previous) {
                throw new ValidationError(peer.name + " CSN hasn't been incremented");
            } else {
                peer.csnPair.theirs = current;
            }
        }
    }

    /**
     * Validate the nonce cookie.
     */
    private validateNonceCookie(nonce: Nonce): void {
        const peer = this.getPeerWithId(nonce.source);
        if (peer !== null && peer.cookiePair.theirs !== null) {
            if (!nonce.cookie.equals(peer.cookiePair.theirs)) {
                throw new ValidationError(peer.name + " cookie changed");
            }
        }
    }

    /**
     * Validate a repeated cookie in an incoming Auth / Server-Auth message.
     *
     * If it does not equal our own cookie, throw a ProtocolError.
     */
    protected validateRepeatedCookie(peer: Peer, repeatedCookieBytes: ArrayBuffer): void {
        const repeatedCookie = Cookie.fromArrayBuffer(repeatedCookieBytes);
        if (!repeatedCookie.equals(peer.cookiePair.ours)) {
            console.debug(this.logTag, 'Their cookie:', repeatedCookie.bytes);
            console.debug(this.logTag, 'Our cookie:', peer.cookiePair.ours.bytes);
            throw new ProtocolError('Peer repeated cookie does not match our cookie');
        }
    }

    /**
     * Validate the signed keys sent by the server in the server-auth message.
     *
     * @param signed_keys The `signed_keys` field from the server-auth message.
     * @param nonce The incoming message nonce.
     * @param serverPublicKey The expected server public permanent key.
     * @throws ValidationError if the signed keys are not valid.
     */
    protected validateSignedKeys(signed_keys: ArrayBuffer, nonce: Nonce, serverPublicKey: Uint8Array): void {
        if (signed_keys === null || signed_keys === undefined) {
            throw new ValidationError("Server did not send signed_keys in server-auth message");
        }
        const box = new Box(new Uint8Array(nonce.toArrayBuffer()), new Uint8Array(signed_keys), nacl.box.nonceLength);
        console.debug(this.logTag, "Expected server public permanent key is", u8aToHex(serverPublicKey));
        console.debug(this.logTag, "Server public session key is", u8aToHex(this.server.sessionKey));
        let decrypted: Uint8Array;
        try {
            decrypted = this.permanentKey.decrypt(box, serverPublicKey);
        } catch (e) {
            if (e === 'decryption-failed') {
                throw new ValidationError("Could not decrypt signed_keys in server_auth message");
            } throw e;
        }
        const expected = concat(this.server.sessionKey, this.permanentKey.publicKeyBytes);
        if (!arraysAreEqual(decrypted, expected)) {
            throw new ValidationError("Decrypted signed_keys in server-auth message is invalid");
        }
    }

    /**
     * Decode the decrypted message and validate type.
     *
     * If decoding fails, throw a `ProtocolError`.
     *
     * If `enforce` is set to true and the actual type does not match the
     * expected type, throw a `ProtocolError`.
     *
     * @throws ProtocolError
     */
    protected decodeMessage(data: Uint8Array, expectedType?: saltyrtc.messages.MessageType | string,
                            enforce=false): saltyrtc.Message {
        // Decode
        const msg = this.msgpackDecode(data) as saltyrtc.Message;

        if (msg.type === undefined) {
            throw new ProtocolError('Malformed ' + expectedType + ' message: Failed to decode msgpack data.');
        }

        // Validate type
        if (enforce && expectedType !== undefined && msg.type !== expectedType) {
            throw new ProtocolError('Invalid ' + expectedType + ' message, bad type: ' + msg);
        }

        return msg;
    }

    /**
     * Build and return a packet containing the specified message for the
     * specified receiver.
     *
     * Returns encrypted msgpacked bytes, ready to send.
     *
     * May throw a `ProtocolError`.
     */
    protected buildPacket(message: saltyrtc.Message, receiver: Peer, encrypt=true): Uint8Array {
        // Choose proper sequence number
        let csn: saltyrtc.NextCombinedSequence;
        try {
            csn = receiver.csnPair.ours.next();
        } catch (e) {
            throw new ProtocolError("CSN overflow: " + (e as Error).message);
        }

        // Create nonce
        const nonce = new Nonce(receiver.cookiePair.ours,
            csn.overflow, csn.sequenceNumber, this.address, receiver.id);
        const nonceBytes = new Uint8Array(nonce.toArrayBuffer());

        // Encode message
        const data: Uint8Array = this.msgpackEncode(message);

        // Non encrypted messages can be created by concatenation
        if (encrypt === false) {
            return concat(nonceBytes, data);
        }

        // Otherwise, encrypt packet
        // TODO: Use polymorphism using peer object (#65)
        let box;
        if (receiver.id === Signaling.SALTYRTC_ADDR_SERVER) {
            box = this.encryptHandshakeDataForServer(data, nonceBytes);
        } else if (receiver.id === Signaling.SALTYRTC_ADDR_INITIATOR || isResponderId(receiver.id)) {
            box = this.encryptHandshakeDataForPeer(receiver.id, message.type, data, nonceBytes);
        } else {
            throw new ProtocolError('Bad receiver byte: ' + receiver);
        }
        return box.toUint8Array();
    }

    /**
     * Encrypt data for the server.
     */
    protected encryptHandshakeDataForServer(payload: Uint8Array, nonceBytes: Uint8Array): saltyrtc.Box {
        return this.permanentKey.encrypt(payload, nonceBytes, this.server.sessionKey);
    }

    /**
     * Encrypt data for the specified peer.
     */
    protected abstract encryptHandshakeDataForPeer(receiver: number, messageType: string,
                                                   payload: Uint8Array, nonceBytes: Uint8Array): saltyrtc.Box;

    /**
     * Get the peer instance (initiator or responder).
     *
     * May return null if peer is not yet set.
     */
    protected abstract getPeer(): Initiator | Responder;

    /**
     * Get the session key of the peer.
     *
     * May return null if peer is not yet set.
     */
    protected abstract getPeerSessionKey(): Uint8Array;

    /**
     * Get the permanent key of the peer.
     *
     * May return null if peer is not yet set.
     */
    protected abstract getPeerPermanentKey(): Uint8Array;

    /**
     * Decrypt data from the peer using the session keys.
     */
    public decryptData(box: saltyrtc.Box): ArrayBuffer {
        const decryptedBytes = this.sessionKey.decrypt(box, this.getPeerSessionKey());

        // We need to return an ArrayBuffer, but we can't directly return
        // `decryptedBytes.buffer` because the `Uint8Array` could be a view
        // into the underlying buffer. Therefore we return a view into the
        // ArrayBuffer instead.
        const start = decryptedBytes.byteOffset;
        const end = start + decryptedBytes.byteLength;
        return decryptedBytes.buffer.slice(start, end);
    }

    /**
     * Reset/close the connection.
     *
     * - Close WebSocket if still open
     * - Set `this.ws` to `null`
     * - Set `this.status` to `new`
     * - Reset the server combined sequence
     */
    public resetConnection(reason?: number): void {
        // Close WebSocket instance
        if (this.ws !== null) {
            console.debug(this.logTag, 'Disconnecting WebSocket (close code ' + reason + ')');
            if (reason == CloseCode.GoingAway) {
                // See https://github.com/saltyrtc/saltyrtc-meta/pull/111/
                this.ws.close();
            } else {
                this.ws.close(reason);
            }
        }
        this.ws = null;

        // Reset
        this.server = new Server();
        this.handoverState.reset();
        this.setState('new');
        if (reason !== undefined) {
            console.debug(this.logTag, 'Connection reset');
        }

        // TODO: Close task? (#64)
    }


    /**
     * Initialize the task with the task data sent by the peer.
     * Set it as the current task.
     *
     * @param task The task instance.
     * @param data The task data provided by the peer.
     * @throws SignalingError
     */
    protected initTask(task: saltyrtc.Task, data: Object): void {
        try {
            task.init(this, data);
        } catch (e) {
            if (e.name === 'ValidationError') {
                throw new ProtocolError("Peer sent invalid task data");
            } throw e;
        }
        this.task = task;
    }

    /**
     * Decrypt and decode a P2P message, encrypted with the session key.
     *
     * When `convertErrors` is set to `true`, decryption errors will be
     * converted to a `ProtocolError`.
     */
    public decryptPeerMessage(box: saltyrtc.Box, convertErrors=true): saltyrtc.Message {
        try {
            const decrypted = this.sessionKey.decrypt(box, this.getPeerSessionKey());
            return this.decodeMessage(decrypted, 'peer');
        } catch(e) {
            if (convertErrors === true && e === 'decryption-failed') {
                const nonce = Nonce.fromArrayBuffer(box.nonce.buffer);
                throw new ProtocolError('Could not decrypt peer message from ' + byteToHex(nonce.source));
            } else { throw e; }
        }
    }

    /**
     * Decrypt and decode a server message.
     */
    public decryptServerMessage(box: saltyrtc.Box): saltyrtc.Message {
        try {
            const decrypted = this.permanentKey.decrypt(box, this.server.sessionKey);
            return this.decodeMessage(decrypted, 'server');
        } catch(e) {
            if (e === 'decryption-failed') {
                throw new ProtocolError('Could not decrypt server message');
            } else { throw e; }
        }
    }

    /**
     * Send an application message to the peer.
     * @param msg The message to be sent.
     */
    public sendApplication(msg: saltyrtc.messages.Application): void {
        this.sendPostClientHandshakeMessage(msg, 'application');
    }

    /**
     * Send a task message through the websocket or - if handover has
     * already happened - through the task channel.
     *
     * @param msg The message to be sent.
     * @throws SignalingError
     */
    public sendTaskMessage(msg: saltyrtc.messages.TaskMessage): void {
        this.sendPostClientHandshakeMessage(msg, 'task');
    }

    /**
     * Send messages after the client to client handshake has been completed.
     * @throws SignalingError if client to client handshake has not been completed.
     */
    private sendPostClientHandshakeMessage(msg: saltyrtc.messages.TaskMessage | saltyrtc.messages.Application, name: string): void {
        if (this.state !== 'task') {
            throw new SignalingError(CloseCode.ProtocolError,
                'Cannot send ' + name + ' message in "' + this.state + '" state');
        }

        const receiver = this.getPeer();
        if (receiver === null) {
            throw new SignalingError(CloseCode.InternalError, 'No peer address could be found');
        }

        if (this.handoverState.local === true) {
            console.debug('Sending', name, 'message through dc');
            this.task.sendSignalingMessage(this.msgpackEncode(msg));
        } else {
            console.debug('Sending', name, 'message through ws');
            const packet = this.buildPacket(msg, receiver);
            this.ws.send(packet);
        }
    }

    /**
     * Encrypt data for the peer using the session key and the specified nonce.
     *
     * This method should primarily be used by tasks.
     */
    public encryptForPeer(data: Uint8Array, nonce: Uint8Array): saltyrtc.Box {
        return this.sessionKey.encrypt(data, nonce, this.getPeerSessionKey());
    }

    /**
     * Decrypt data from the peer using the session key.
     *
     * This method should primarily be used by tasks.
     */
    public decryptFromPeer(box: saltyrtc.Box): Uint8Array {
        try {
            return this.sessionKey.decrypt(box, this.getPeerSessionKey());
        } catch (e) {
            if (e === 'decryption-failed') {
                // This could only happen if the session keys are somehow broken.
                // If that happens, something went massively wrong.
                if (this.state === 'task') {
                    this.sendClose(CloseCode.InternalError);
                }
                this.resetConnection(CloseCode.InternalError);
                throw new SignalingError(CloseCode.InternalError,
                    "Decryption of peer message failed. This should not happen.");
            } else {
                throw e;
            }
        }
    }

}
