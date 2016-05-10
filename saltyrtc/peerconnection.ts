/**
 * Copyright (C) 2016 Threema GmbH / SaltyRTC Contributors
 *
 * This software may be modified and distributed under the terms
 * of the MIT license.  See the `LICENSE.md` file for details.
 */

/// <reference path="types/angular.d.ts" />
/// <reference path='types/RTCPeerConnection.d.ts' />

class PeerConnection {

    private $log: angular.ILogService;
    private $rootScope: angular.IRootScopeService;
    private _state: string;
    private _options: RTCPeerConnectionConfig;
    private _constraints: RTCMediaConstraints;
    private _events: PeerConnectionEvents = null;
    private candidates: any[]; // TODO type
    public pc: RTCPeerConnection = null;  // TODO: Can this be made private?
    private offerCreated: boolean;
    private descriptionsExchanged: boolean;

    // Default peer connection options
    static OPTIONS = {
        iceServers: [{
            url: 'turn:example.com',
            username: 'user',
            credential: 'pass',
        }],
        optional: {
            DtlsSrtpKeyAgreement: true
        }
    };

    // Default offer/answer constraints
    static CONSTRAINTS: Object = {
        mandatory: {
            OfferToReceiveAudio: false,
            OfferToReceiveVideo: false,
        }
    };

    constructor($log, $rootScope) {
        this.$log = $log;
        this.$rootScope = $rootScope;

        // Set state property
        this.state = 'unknown'
    }

    // TODO: Use enums for states
    set state(newState: string) {
        // Ignore repeated state changes
        if (newState == this._state) {
            this.$log.debug('Ignoring repeated peer connection state:', newState);
            return;
        }

        // Update state and broadcast
        this._state = newState;
        this.$rootScope.$broadcast('pc:state', newState);
    }

    reset() {
        this.state = 'unknown';

        // Close and reset event instance
        if (this._events !== null) {
            this._events.stop();
        }
        this._events = new PeerConnectionEvents(this, this.$log, this.$rootScope);

        // Close peer connection instance
        if (this.pc !== null) {
            this.$log.debug('Closing peer connection');
            this.pc.close();
            this.pc = null;
        }
        this.offerCreated = false;
        this.descriptionsExchanged = false;

        // Cached ICE candidates
        this.candidates = [];

        // Reset options
        this._options = null;
        this._constraints = null;
    }

    create(options={}, constraints={}) {
        // Override defaults
        this._options = angular.extend(PeerConnection.OPTIONS, options);
        this._constraints = angular.extend(PeerConnection.CONSTRAINTS, constraints);

        // Create peer connection
        this.state = 'init';
        this.pc = new RTCPeerConnection(this._options);
        this.$log.debug('Peer Connection created');

        // Session negotiation needs to be done at some point in the near future
        this.pc.onnegotiationneeded = this._events.onNegotiationNeeded;

        // A new ice candidate has been made available
        // http://www.w3.org/TR/webrtc/#idl-def-RTCIceCandidate
        // [RTCIceCandidate] event.candidate
        this.pc.onicecandidate = this._events.onIceCandidate;

        // Signaling state changed, caused by setting local or remote description
        // http://www.w3.org/TR/webrtc/#idl-def-RTCSignalingState
        // [RTCSignalingState] pc.signalingState
        this.pc.onsignalingstatechange = this._events.onSignalingStateChange;

        // Remote peer added a media stream
        // http://www.w3.org/TR/webrtc/#dfn-mediastream
        // [MediaStream] event.stream
        this.pc.onaddstream = this._events.onAddStream;

        // Remote peer removed a media stream
        // http://www.w3.org/TR/webrtc/#dfn-mediastream
        // [MediaStream] event.stream
        this.pc.onremovestream = this._events.onRemoveStream;

        // ICE connection state changed
        // http://www.w3.org/TR/webrtc/#idl-def-RTCIceConnectionState
        // [RTCIceConnectionState] pc.iceConnectionState
        this.pc.oniceconnectionstatechange = this._events.onIceConnectionStateChange;

        // The remote peer created a data channel
        // http://www.w3.org/TR/webrtc/#idl-def-RTCDataChannel
        // [RTCDataChannel] event.channel
        this.pc.ondatachannel = this._events.onDataChannel;
    }

    sendOffer() {
        // Check if the offer has already been created
        if (this.offerCreated) {
            this.$log.debug('Offer has already been sent, ignored call');
            return;
        }
        this.offerCreated = true;

        this.$log.info('Creating offer');

        // Create offer, set local description and send on success
        this.pc.createOffer(
            (description) => {
                // Broadcast after second callback was successful
                this.pc.setLocalDescription(
                    description,
                    () => {
                        this.$log.debug('Local description set');
                        this.$rootScope.$broadcast('pc:offer', description);
                    },
                    (error) => {
                        this.$log.error('Setting local description failed:', error);
                        this.$rootScope.$broadcast('pc:error', 'local', error);
                    }
                );
            },
            (error) => {
                this.$log.error('Creating offer failed:', error);
                this.$rootScope.$broadcast('pc:error', 'create', error);
            },
            this._constraints
        );
    }

    receiveAnswer(descriptionInit: RTCSessionDescriptionInit) {
        this.$log.info('Received answer');
        let description = new RTCSessionDescription(descriptionInit);
        this.pc.setRemoteDescription(
            description,
            () => {
                // Success: Send cached ICE candidates
                this.$log.debug('Remote description set');
                this._sendCachedCandidates();
            },
            (error) => {
                this.$log.error('Setting remote description failed:', error);
                this.$rootScope.$broadcast('pc:error', 'remote', error);
            }
        );
    }

    sendCandidate(candidate: any) {
        if (this.descriptionsExchanged) {
            // Send candidate
            this.$log.debug('Broadcasting candidate');
            this.$rootScope.$broadcast('pc:candidate', candidate);
        } else {
            // Cache candidates if no answer has been received yet
            this.candidates.push(candidate);
        }
    }

    receiveCandidate(candidate: any) {
        this.$log.debug('Received candidate');
        candidate = new RTCIceCandidate(candidate);
        this.pc.addIceCandidate(
            candidate,
            () => this.$log.debug('Candidate set'),
            (error) => {
                this.$log.error('Adding candidate failed:', error);
                this.$rootScope.$broadcast('pc:error', 'candidate', error);
            }
        )
    }

    _sendCachedCandidates() {
        this.descriptionsExchanged = true;
        this.$log.debug('Sending ' + this.candidates.length + ' delayed candidates');
        // Send cached candidates
        for (var candidate of this.candidates) {
            this.sendCandidate(candidate);
        }
        this.candidates = [];
    }

}


/**
 * A class that contains event handlers for the RTCPeerConnection.
 */
class PeerConnectionEvents {

    private _stopped: boolean;
    private _pc: PeerConnection;
    private $log: angular.ILogService;
    private $rootScope: angular.IRootScopeService;

    constructor(pc: PeerConnection,
                $log: angular.ILogService, $rootScope: angular.IRootScopeService) {
        this._stopped = false;
        this._pc = pc;
        this.$log = $log;
        this.$rootScope = $rootScope;
    }

    stop() {
        this._stopped = true;
    }

    onNegotiationNeeded = (event: Event) => {
        if (!this._stopped) {
            this.$log.warn('Ignored peer connection negotiation request');
        }
    };

    onIceCandidate = (event: RTCIceCandidateEvent) => {
        if (!this._stopped) {
            this.$rootScope.$apply(() => {
                // Send the candidate
                if (event.candidate) {
                    this._pc.sendCandidate(event.candidate);
                }
            })
        }
    };

    onSignalingStateChange = (event: Event) => {
        if (!this._stopped) {
            this.$log.debug('Ignored signaling state change to:',
                            this._pc.pc.signalingState);
        }
    };

    onAddStream = (event: RTCMediaStreamEvent) => {
        if (!this._stopped) {
            this.$log.warn('Ignored incoming media stream');
        }
    };

    onRemoveStream = (event: RTCMediaStreamEvent) => {
        if (!this._stopped) {
            this.$log.warn('Ignored media stream removal');
        }
    };

    onIceConnectionStateChange = (event: Event) => {
        if (!this._stopped) {
            this.$rootScope.$apply(() => {
                this._pc.state = this._pc.pc.iceConnectionState;
            })
        }
    };

    onDataChannel = (event: Event) => {
        if (!this._stopped) {
            this.$log.warn('Ignored incoming data channel');
        }
    };

}
