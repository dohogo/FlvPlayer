import { mergeBuffer, throttle, calculationRate } from '../utils';
import { checkReadableStream } from '../utils/isSupported';

export default class FetchLoader {
    constructor(flv) {
        this.flv = flv;
        const { options, player } = flv;
        this.byteLength = 0;
        this.reader = null;
        this.chunkStart = 0;
        this.contentLength = 0;
        this.data = new Uint8Array();
        this.readChunk = throttle(this.readChunk, 1000);
        this.chunkSize = options.hasAudio ? options.videoChunk : options.videoChunk + options.audioChunk;

        this.streamRate = calculationRate(rate => {
            flv.emit('streamRate', rate);
        });

        flv.on('destroy', () => {
            this.reader.cancel();
            this.data = null;
        });

        flv.on('timeupdate', currentTime => {
            if (!options.live && player.loaded - currentTime <= 5) {
                this.readChunk();
            }
        });

        if (checkReadableStream()) {
            this.initFetchStream();
        } else {
            fetch(options.url, {
                method: 'head',
                credentials: options.withCredentials ? 'include' : 'omit',
                mode: options.cors ? 'cors' : 'no-cors',
                headers: {
                    range: 'bytes=0-1024',
                },
            })
                .then(response => {
                    this.contentLength = Number(response.headers.get('content-length')) || options.filesize;
                    this.flv.emit('streamStart');
                    this.initFetchRange(0, this.chunkSize);
                })
                .catch(error => {
                    flv.emit('streamError', error);
                    throw error;
                });
        }
    }

    readChunk() {
        const chunkEnd = Math.min(this.chunkStart + this.chunkSize, this.data.length);
        if (chunkEnd > this.chunkStart) {
            const chunkData = this.data.subarray(this.chunkStart, chunkEnd);
            this.flv.emit('streaming', chunkData);
            this.chunkStart = chunkEnd;
        }
    }

    initFetchStream() {
        const { options, debug } = this.flv;
        const self = this;
        this.flv.emit('streamStart');
        return fetch(options.url, {
            credentials: options.withCredentials ? 'include' : 'omit',
            mode: options.cors ? 'cors' : 'no-cors',
            headers: options.headers,
        })
            .then(response => {
                self.reader = response.body.getReader();
                return (function read() {
                    return self.reader
                        .read()
                        .then(({ done, value }) => {
                            if (done) {
                                self.flv.emit('streamEnd');
                                debug.log('stream-end', `${self.byteLength} byte`);
                                return;
                            }

                            const uint8 = new Uint8Array(value);
                            self.byteLength += uint8.byteLength;
                            self.streamRate(uint8.byteLength);

                            if (options.live) {
                                self.flv.emit('streaming', uint8);
                            } else {
                                self.data = mergeBuffer(self.data, uint8);
                                if (self.chunkStart === 0) {
                                    self.readChunk();
                                }
                            }

                            // eslint-disable-next-line consistent-return
                            return read();
                        })
                        .catch(error => {
                            self.flv.emit('streamError', error);
                            throw error;
                        });
                })();
            })
            .catch(error => {
                self.flv.emit('streamError', error);
                throw error;
            });
    }

    initFetchRange(rangeStart, rangeEnd) {
        const { options } = this.flv;
        const self = this;
        const rangeUrl = new URL(options.url);
        rangeUrl.searchParams.append('range', `${rangeStart}-${rangeEnd}`);
        return fetch(rangeUrl.href, {
            credentials: options.withCredentials ? 'include' : 'omit',
            mode: options.cors ? 'cors' : 'no-cors',
            headers: {
                ...options.headers,
                range: `bytes=${rangeStart}-${rangeEnd}`,
            },
        })
            .then(response => response.arrayBuffer())
            .then(value => {
                const uint8 = new Uint8Array(value);
                self.byteLength += uint8.byteLength;
                self.streamRate(uint8.byteLength);

                if (options.live) {
                    self.flv.emit('streaming', uint8);
                } else {
                    self.data = mergeBuffer(self.data, uint8);
                    if (self.chunkStart === 0) {
                        self.readChunk();
                    }
                }

                const nextRangeStart = Math.min(self.contentLength, rangeEnd + 1);
                const nextRangeEnd = Math.min(self.contentLength, nextRangeStart + self.chunkSize);
                if (nextRangeEnd > nextRangeStart) {
                    self.initFetchRange(nextRangeStart, nextRangeEnd);
                }
            })
            .catch(error => {
                self.flv.emit('streamError', error);
                throw error;
            });
    }
}
