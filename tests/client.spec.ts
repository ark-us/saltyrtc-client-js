/// <reference path="jasmine.d.ts" />

import { sleep } from "./utils";
import { SaltyRTCBuilder } from "../saltyrtc/client";
import { KeyStore } from "../saltyrtc/keystore";

export default () => { describe('client', function() {

    describe('SaltyRTCBuilder', function() {

        it('can construct an untrusted initiator', () => {
            const salty = new SaltyRTCBuilder()
                .connectTo('localhost')
                .withKeyStore(new KeyStore())
                .asInitiator();
            expect(((salty as any).signaling as any).role).toEqual('initiator');
            expect(((salty as any).signaling as any).peerTrustedKey).toBeNull();
        });

        it('can construct a trusted initiator', () => {
            const trustedKey = nacl.randomBytes(32);
            const salty = new SaltyRTCBuilder()
                .connectTo('localhost')
                .withKeyStore(new KeyStore())
                .withTrustedPeerKey(trustedKey)
                .asInitiator();
            expect(((salty as any).signaling as any).role).toEqual('initiator');
            expect(((salty as any).signaling as any).peerTrustedKey).toEqual(trustedKey);
        });

        it('can construct an untrusted responder', () => {
            const pubKey = nacl.randomBytes(32);
            const authToken = nacl.randomBytes(32);
            const salty = new SaltyRTCBuilder()
                .connectTo('localhost')
                .withKeyStore(new KeyStore())
                .initiatorInfo(pubKey, authToken)
                .asResponder();
            expect(((salty as any).signaling as any).role).toEqual('responder');
            expect(((salty as any).signaling as any).initiator.permanentKey).toEqual(pubKey);
            expect(((salty as any).signaling as any).authToken.keyBytes).toEqual(authToken);
            expect(((salty as any).signaling as any).peerTrustedKey).toBeNull();
        });

        it('can construct a trusted responder', () => {
            const trustedKey = nacl.randomBytes(32);
            const salty = new SaltyRTCBuilder()
                .connectTo('localhost')
                .withKeyStore(new KeyStore())
                .withTrustedPeerKey(trustedKey)
                .asResponder();
            expect(((salty as any).signaling as any).role).toEqual('responder');
            expect(((salty as any).signaling as any).peerTrustedKey).toEqual(trustedKey);
            expect(((salty as any).signaling as any).initiator.permanentKey).toEqual(trustedKey);
            expect(((salty as any).signaling as any).authToken).toBeNull();
        });

    });

    describe('SaltyRTC', function() {

        /*it('wrapDataChannel() acts as a proxy', () => {
            let pc = new RTCPeerConnection({iceServers: [{urls: ['stun:stun.services.mozilla.com']}]});
            let dc = pc.createDataChannel("dc1");
            let sc = new SaltyRTC(new KeyStore(), 'localhost');
            let proxy = sc.wrapDataChannel(dc);
            proxy.send("hello");
        });*/

        describe('events', function() {

            beforeEach(() => {
                this.sc = new SaltyRTCBuilder()
                    .connectTo('localhost')
                    .withKeyStore(new KeyStore())
                    .asInitiator();
            });

            it('can emit events', async (done) => {
                this.sc.on('connected', () => {
                    expect(true).toBe(true);
                    done();
                });
                this.sc.emit({type: 'connected'});
            });

            it('only calls handlers for specified events', async (done) => {
                let counter = 0;
                this.sc.on(['connected', 'data'], () => {
                    counter += 1;
                });
                this.sc.emit({type: 'connected'});
                this.sc.emit({type: 'data'});
                this.sc.emit({type: 'connection-error'});
                this.sc.emit({type: 'connected'});
                await sleep(20);
                expect(counter).toEqual(3);
                done();
            });

            it('only adds a handler once', async (done) => {
                let counter = 0;
                let handler = () => {counter += 1;};
                this.sc.on('data', handler);
                this.sc.on('data', handler);
                this.sc.emit({type: 'data'});
                await sleep(20);
                expect(counter).toEqual(1);
                done();
            });

            it('can call multiple handlers', async (done) => {
                let counter = 0;
                let handler1 = () => {counter += 1;};
                let handler2 = () => {counter += 1;};
                this.sc.on(['connected', 'data'], handler1);
                this.sc.on(['connected'], handler2);
                this.sc.emit({type: 'connected'});
                this.sc.emit({type: 'data'});
                await sleep(20);
                expect(counter).toEqual(3);
                done();
            });

            it('can cancel handlers', async (done) => {
                let counter = 0;
                let handler = () => {counter += 1;};
                this.sc.on(['data', 'connected'], handler);
                this.sc.emit({type: 'connected'});
                this.sc.emit({type: 'data'});
                this.sc.off('data', handler);
                this.sc.emit({type: 'connected'});
                this.sc.emit({type: 'data'});
                await sleep(20);
                expect(counter).toEqual(3);
                done();
            });

            it('can cancel handlers for multiple events', async (done) => {
                let counter = 0;
                let handler = () => {counter += 1;};
                this.sc.on(['data', 'connected'], handler);
                this.sc.emit({type: 'connected'});
                this.sc.emit({type: 'data'});
                this.sc.off(['data', 'connected'], handler);
                this.sc.emit({type: 'connected'});
                this.sc.emit({type: 'data'});
                await sleep(20);
                expect(counter).toEqual(2);
                done();
            });

            it('can register one-time handlers', async (done) => {
                let counter = 0;
                let handler = () => {counter += 1;};
                this.sc.once('data', handler);
                this.sc.emit({type: 'data'});
                this.sc.emit({type: 'data'});
                await sleep(20);
                expect(counter).toEqual(1);
                done();
            });

            it('can register one-time handlers that throw', async (done) => {
                let counter = 0;
                let handler = () => {counter += 1; throw 'oh noes';};
                this.sc.once('data', handler);
                this.sc.emit({type: 'data'});
                this.sc.emit({type: 'data'});
                await sleep(20);
                expect(counter).toEqual(1);
                done();
            });

            it('removes handlers that return false', async (done) => {
                let counter = 0;
                let handler = () => {
                    if (counter <= 4) {
                        counter += 1;
                    } else {
                        return false;
                    }
                };
                this.sc.on('data', handler);
                for (let i = 0; i < 7; i++) {
                    this.sc.emit({type: 'data'});
                }
                await sleep(20);
                expect(counter).toEqual(5);
                done();
            });

        });

    });

}); }
