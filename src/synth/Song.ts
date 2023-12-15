/** @format */

import {
	Dictionary,
	FilterType,
	EnvelopeType,
	InstrumentType,
	EffectType,
	Envelope,
	Config,
	effectsIncludeTransition,
	effectsIncludeChord,
	effectsIncludePitchShift,
	effectsIncludeDetune,
	effectsIncludeVibrato,
	effectsIncludeNoteFilter,
	effectsIncludeDistortion,
	effectsIncludeBitcrusher,
	effectsIncludePanning,
	effectsIncludeChorus,
	effectsIncludeEcho,
	effectsIncludeReverb
} from "./SynthConfig";
import { EditorConfig } from "../editor/EditorConfig";
import { BitFieldReader } from "./BitFieldReader";
import { BitFieldWriter } from "./BitFieldWriter";
import { SongTagCode } from "./Types";
import { base64IntToCharCode } from "./Types";
import { base64CharCodeToInt } from "./Types";
import { CharCode } from "./Types";
import { Note } from "./Note";
import { NotePin } from "./Note";
import { makeNotePin } from "./Note";
import { Pattern } from "./Pattern";
import { Instrument } from "./Instrument";
import { Channel, validateRange, clamp, LegacySettings, Synth } from "./synth";
import { FilterControlPoint } from "./Filter";
import { FilterSettings } from "./Filter";

export class Song {
	private static readonly _format: string = "BeepBox";
	private static readonly _oldestBeepboxVersion: number = 2;
	private static readonly _latestBeepboxVersion: number = 9;
	private static readonly _oldestJummBoxVersion: number = 1;
	private static readonly _latestJummBoxVersion: number = 5;
	// One-character variant detection at the start of URL to distinguish variants such as JummBox.
	private static readonly _variant = 106; //"j" ~ jummbox

	public title: string = "";
	public scale: number = 0;
	public key: number = 0;
	public tempo: number = 0;
	public reverb: number = 0;
	public beatsPerBar: number = 0;
	public barCount: number = 0;
	public patternsPerChannel: number = 0;
	public rhythm: number = 0;
	public layeredInstruments: boolean = false;
	public patternInstruments: boolean = false;
	public loopStart: number = 0;
	public loopLength: number = 0;
	public pitchChannelCount: number = 0;
	public noiseChannelCount: number = 0;
	public modChannelCount: number = 0;
	public readonly channels: Channel[] = [];
	public limitDecay: number = 4;
	public limitRise: number = 4000;
	public compressionThreshold: number = 1;
	public limitThreshold: number = 1;
	public compressionRatio: number = 1;
	public limitRatio: number = 1;
	public masterGain: number = 1;
	public inVolumeCap: number = 0;
	public outVolumeCap: number = 0;

	constructor(string?: string) {
		if (string != undefined) {
			this.fromBase64String(string);
		} else {
			this.initToDefault(true);
		}
	}

	// Returns the ideal new note volume when dragging (max volume for a normal note, a "neutral" value for mod notes based on how they work)
	public getNewNoteVolume = (
		isMod: boolean,
		modChannel?: number,
		modInstrument?: number,
		modCount?: number
	): number => {
		if (!isMod || modChannel == undefined || modInstrument == undefined || modCount == undefined) return 6;
		else {
			// Sigh, the way pitches count up and the visual ordering in the UI are flipped.
			modCount = Config.modCount - modCount - 1;

			let vol: number | undefined =
				Config.modulators[this.channels[modChannel].instruments[modInstrument].modulators[modCount]].newNoteVol;

			// For tempo, actually use user defined tempo
			let tempoIndex: number = Config.modulators.dictionary["tempo"].index;
			if (this.channels[modChannel].instruments[modInstrument].modulators[modCount] == tempoIndex) {
				vol = this.tempo - Config.modulators[tempoIndex].convertRealFactor;
			}

			if (vol != undefined) return vol;
			else return 6;
		}
	};

	public getVolumeCap = (isMod: boolean, modChannel?: number, modInstrument?: number, modCount?: number): number => {
		if (!isMod || modChannel == undefined || modInstrument == undefined || modCount == undefined) return 6;
		else {
			// Sigh, the way pitches count up and the visual ordering in the UI are flipped.
			modCount = Config.modCount - modCount - 1;

			let instrument: Instrument = this.channels[modChannel].instruments[modInstrument];
			let modulator = Config.modulators[instrument.modulators[modCount]];
			let cap: number | undefined = modulator.maxRawVol;

			if (cap != undefined) {
				// For filters, cap is dependent on which filter setting is targeted
				if (modulator.name == "eq filter" || modulator.name == "note filter") {
					// type 0: number of filter morphs
					// type 1/odd: number of filter x positions
					// type 2/even: number of filter y positions
					cap = Config.filterMorphCount - 1;
					if (instrument.modFilterTypes[modCount] > 0 && instrument.modFilterTypes[modCount] % 2) {
						cap = Config.filterFreqRange;
					} else if (instrument.modFilterTypes[modCount] > 0) {
						cap = Config.filterGainRange;
					}
				}
				return cap;
			} else return 6;
		}
	};

	public getVolumeCapForSetting = (isMod: boolean, modSetting: number, filterType?: number): number => {
		if (!isMod) return Config.noteSizeMax;
		else {
			let cap: number | undefined = Config.modulators[modSetting].maxRawVol;
			if (cap != undefined) {
				// For filters, cap is dependent on which filter setting is targeted
				if (
					filterType != undefined &&
					(Config.modulators[modSetting].name == "eq filter" ||
						Config.modulators[modSetting].name == "note filter")
				) {
					// type 0: number of filter morphs
					// type 1/odd: number of filter x positions
					// type 2/even: number of filter y positions
					cap = Config.filterMorphCount - 1;
					if (filterType > 0 && filterType % 2) {
						cap = Config.filterFreqRange;
					} else if (filterType > 0) {
						cap = Config.filterGainRange;
					}
				}

				return cap;
			} else return Config.noteSizeMax;
		}
	};

	public getChannelCount(): number {
		return this.pitchChannelCount + this.noiseChannelCount + this.modChannelCount;
	}

	public getMaxInstrumentsPerChannel(): number {
		return Math.max(
			this.layeredInstruments ? Config.layeredInstrumentCountMax : Config.instrumentCountMin,
			this.patternInstruments ? Config.patternInstrumentCountMax : Config.instrumentCountMin
		);
	}

	public getMaxInstrumentsPerPattern(channelIndex: number): number {
		return this.getMaxInstrumentsPerPatternForChannel(this.channels[channelIndex]);
	}

	public getMaxInstrumentsPerPatternForChannel(channel: Channel): number {
		return this.layeredInstruments ? Math.min(Config.layeredInstrumentCountMax, channel.instruments.length) : 1;
	}

	public getChannelIsNoise(channelIndex: number): boolean {
		return channelIndex >= this.pitchChannelCount && channelIndex < this.pitchChannelCount + this.noiseChannelCount;
	}

	public getChannelIsMod(channelIndex: number): boolean {
		return channelIndex >= this.pitchChannelCount + this.noiseChannelCount;
	}

	public initToDefault(andResetChannels: boolean = true): void {
		this.scale = 0;
		this.key = 0;
		this.loopStart = 0;
		this.loopLength = 4;
		this.tempo = 150;
		this.reverb = 0;
		this.beatsPerBar = 8;
		this.barCount = 16;
		this.patternsPerChannel = 8;
		this.rhythm = 1;
		this.layeredInstruments = false;
		this.patternInstruments = false;

		this.title = "Unnamed";
		document.title = EditorConfig.versionDisplayName;

		if (andResetChannels) {
			this.pitchChannelCount = 3;
			this.noiseChannelCount = 1;
			this.modChannelCount = 0;
			for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
				const isNoiseChannel: boolean =
					channelIndex >= this.pitchChannelCount &&
					channelIndex < this.pitchChannelCount + this.noiseChannelCount;
				const isModChannel: boolean = channelIndex >= this.pitchChannelCount + this.noiseChannelCount;
				if (this.channels.length <= channelIndex) {
					this.channels[channelIndex] = new Channel();
				}
				const channel: Channel = this.channels[channelIndex];
				channel.octave = Math.max(3 - channelIndex, 0); // [3, 2, 1, 0]; Descending octaves with drums at zero in last channel.

				for (let pattern: number = 0; pattern < this.patternsPerChannel; pattern++) {
					if (channel.patterns.length <= pattern) {
						channel.patterns[pattern] = new Pattern();
					} else {
						channel.patterns[pattern].reset();
					}
				}
				channel.patterns.length = this.patternsPerChannel;

				for (let instrument: number = 0; instrument < Config.instrumentCountMin; instrument++) {
					if (channel.instruments.length <= instrument) {
						channel.instruments[instrument] = new Instrument(isNoiseChannel, isModChannel);
					}
					channel.instruments[instrument].setTypeAndReset(
						isModChannel ? InstrumentType.mod : isNoiseChannel ? InstrumentType.noise : InstrumentType.chip,
						isNoiseChannel,
						isModChannel
					);
				}
				channel.instruments.length = Config.instrumentCountMin;

				for (let bar: number = 0; bar < this.barCount; bar++) {
					channel.bars[bar] = bar < 4 ? 1 : 0;
				}
				channel.bars.length = this.barCount;
			}
			this.channels.length = this.getChannelCount();
		}
	}

	public toBase64String(): string {
		let bits: BitFieldWriter;
		let buffer: number[] = [];

		buffer.push(Song._variant);
		buffer.push(base64IntToCharCode[Song._latestJummBoxVersion]);

		// Length of the song name string
		buffer.push(SongTagCode.songTitle);
		var encodedSongTitle: string = encodeURIComponent(this.title);
		buffer.push(
			base64IntToCharCode[encodedSongTitle.length >> 6],
			base64IntToCharCode[encodedSongTitle.length & 63]
		);

		// Actual encoded string follows
		for (let i: number = 0; i < encodedSongTitle.length; i++) {
			buffer.push(encodedSongTitle.charCodeAt(i));
		}

		buffer.push(
			SongTagCode.channelCount,
			base64IntToCharCode[this.pitchChannelCount],
			base64IntToCharCode[this.noiseChannelCount],
			base64IntToCharCode[this.modChannelCount]
		);
		buffer.push(SongTagCode.scale, base64IntToCharCode[this.scale]);
		buffer.push(SongTagCode.key, base64IntToCharCode[this.key]);
		buffer.push(
			SongTagCode.loopStart,
			base64IntToCharCode[this.loopStart >> 6],
			base64IntToCharCode[this.loopStart & 63]
		);
		buffer.push(
			SongTagCode.loopEnd,
			base64IntToCharCode[(this.loopLength - 1) >> 6],
			base64IntToCharCode[(this.loopLength - 1) & 63]
		);
		buffer.push(SongTagCode.tempo, base64IntToCharCode[this.tempo >> 6], base64IntToCharCode[this.tempo & 63]);
		buffer.push(SongTagCode.beatCount, base64IntToCharCode[this.beatsPerBar - 1]);
		buffer.push(
			SongTagCode.barCount,
			base64IntToCharCode[(this.barCount - 1) >> 6],
			base64IntToCharCode[(this.barCount - 1) & 63]
		);
		buffer.push(
			SongTagCode.patternCount,
			base64IntToCharCode[(this.patternsPerChannel - 1) >> 6],
			base64IntToCharCode[(this.patternsPerChannel - 1) & 63]
		);
		buffer.push(SongTagCode.rhythm, base64IntToCharCode[this.rhythm]);

		// Push limiter settings, but only if they aren't the default!
		buffer.push(SongTagCode.limiterSettings);
		if (
			this.compressionRatio != 1 ||
			this.limitRatio != 1 ||
			this.limitRise != 4000 ||
			this.limitDecay != 4 ||
			this.limitThreshold != 1 ||
			this.compressionThreshold != 1 ||
			this.masterGain != 1
		) {
			buffer.push(
				base64IntToCharCode[
					Math.round(
						this.compressionRatio < 1 ? this.compressionRatio * 10 : 10 + (this.compressionRatio - 1) * 60
					)
				]
			); // 0 ~ 1.15 uneven, mapped to 0 ~ 20
			buffer.push(
				base64IntToCharCode[Math.round(this.limitRatio < 1 ? this.limitRatio * 10 : 9 + this.limitRatio)]
			); // 0 ~ 10 uneven, mapped to 0 ~ 20
			buffer.push(base64IntToCharCode[this.limitDecay]); // directly 1 ~ 30
			buffer.push(base64IntToCharCode[Math.round((this.limitRise - 2000) / 250)]); // 2000 ~ 10000 by 250, mapped to 0 ~ 32
			buffer.push(base64IntToCharCode[Math.round(this.compressionThreshold * 20)]); // 0 ~ 1.1 by 0.05, mapped to 0 ~ 22
			buffer.push(base64IntToCharCode[Math.round(this.limitThreshold * 20)]); // 0 ~ 2 by 0.05, mapped to 0 ~ 40
			buffer.push(
				base64IntToCharCode[Math.round(this.masterGain * 50) >> 6],
				base64IntToCharCode[Math.round(this.masterGain * 50) & 63]
			); // 0 ~ 5 by 0.02, mapped to 0 ~ 250
		} else {
			buffer.push(base64IntToCharCode[63]); // Not using limiter
		}

		buffer.push(SongTagCode.channelNames);
		for (let channel: number = 0; channel < this.getChannelCount(); channel++) {
			// Length of the channel name string
			var encodedChannelName: string = encodeURIComponent(this.channels[channel].name);
			buffer.push(
				base64IntToCharCode[encodedChannelName.length >> 6],
				base64IntToCharCode[encodedChannelName.length & 63]
			);

			// Actual encoded string follows
			for (let i: number = 0; i < encodedChannelName.length; i++) {
				buffer.push(encodedChannelName.charCodeAt(i));
			}
		}

		buffer.push(
			SongTagCode.instrumentCount,
			base64IntToCharCode[((<any>this.layeredInstruments) << 1) | (<any>this.patternInstruments)]
		);
		if (this.layeredInstruments || this.patternInstruments) {
			for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
				buffer.push(
					base64IntToCharCode[this.channels[channelIndex].instruments.length - Config.instrumentCountMin]
				);
			}
		}

		buffer.push(SongTagCode.channelOctave);
		for (let channelIndex: number = 0; channelIndex < this.pitchChannelCount; channelIndex++) {
			buffer.push(base64IntToCharCode[this.channels[channelIndex].octave]);
		}

		for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
			for (let i: number = 0; i < this.channels[channelIndex].instruments.length; i++) {
				const instrument: Instrument = this.channels[channelIndex].instruments[i];
				buffer.push(SongTagCode.startInstrument, base64IntToCharCode[instrument.type]);
				buffer.push(
					SongTagCode.volume,
					base64IntToCharCode[(instrument.volume + Config.volumeRange / 2) >> 6],
					base64IntToCharCode[(instrument.volume + Config.volumeRange / 2) & 63]
				);
				buffer.push(
					SongTagCode.preset,
					base64IntToCharCode[instrument.preset >> 6],
					base64IntToCharCode[instrument.preset & 63]
				);

				buffer.push(SongTagCode.eqFilter);
				buffer.push(base64IntToCharCode[+instrument.eqFilterType]);
				if (instrument.eqFilterType) {
					buffer.push(base64IntToCharCode[instrument.eqFilterSimpleCut]);
					buffer.push(base64IntToCharCode[instrument.eqFilterSimplePeak]);
				} else {
					if (instrument.eqFilter == null) {
						// Push null filter settings
						buffer.push(base64IntToCharCode[0]);
						console.log(
							"Null EQ filter settings detected in toBase64String for channelIndex " +
								channelIndex +
								", instrumentIndex " +
								i
						);
					} else {
						buffer.push(base64IntToCharCode[instrument.eqFilter.controlPointCount]);
						for (let j: number = 0; j < instrument.eqFilter.controlPointCount; j++) {
							const point: FilterControlPoint = instrument.eqFilter.controlPoints[j];
							buffer.push(
								base64IntToCharCode[point.type],
								base64IntToCharCode[Math.round(point.freq)],
								base64IntToCharCode[Math.round(point.gain)]
							);
						}
					}

					// Push subfilters as well. Skip Index 0, is a copy of the base filter.
					let usingSubFilterBitfield: number = 0;
					for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
						usingSubFilterBitfield |= +(instrument.eqSubFilters[j + 1] != null) << j;
					}
					// Put subfilter usage into 2 chars (12 bits)
					buffer.push(
						base64IntToCharCode[usingSubFilterBitfield >> 6],
						base64IntToCharCode[usingSubFilterBitfield & 63]
					);
					// Put subfilter info in for all used subfilters
					for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
						if (usingSubFilterBitfield & (1 << j)) {
							buffer.push(base64IntToCharCode[instrument.eqSubFilters[j + 1]!.controlPointCount]);
							for (let k: number = 0; k < instrument.eqSubFilters[j + 1]!.controlPointCount; k++) {
								const point: FilterControlPoint = instrument.eqSubFilters[j + 1]!.controlPoints[k];
								buffer.push(
									base64IntToCharCode[point.type],
									base64IntToCharCode[Math.round(point.freq)],
									base64IntToCharCode[Math.round(point.gain)]
								);
							}
						}
					}
				}

				// The list of enabled effects is represented as a 12-bit bitfield using two six-bit characters.
				buffer.push(
					SongTagCode.effects,
					base64IntToCharCode[instrument.effects >> 6],
					base64IntToCharCode[instrument.effects & 63]
				);
				if (effectsIncludeNoteFilter(instrument.effects)) {
					buffer.push(base64IntToCharCode[+instrument.noteFilterType]);
					if (instrument.noteFilterType) {
						buffer.push(base64IntToCharCode[instrument.noteFilterSimpleCut]);
						buffer.push(base64IntToCharCode[instrument.noteFilterSimplePeak]);
					} else {
						if (instrument.noteFilter == null) {
							// Push null filter settings
							buffer.push(base64IntToCharCode[0]);
							console.log(
								"Null note filter settings detected in toBase64String for channelIndex " +
									channelIndex +
									", instrumentIndex " +
									i
							);
						} else {
							buffer.push(base64IntToCharCode[instrument.noteFilter.controlPointCount]);
							for (let j: number = 0; j < instrument.noteFilter.controlPointCount; j++) {
								const point: FilterControlPoint = instrument.noteFilter.controlPoints[j];
								buffer.push(
									base64IntToCharCode[point.type],
									base64IntToCharCode[Math.round(point.freq)],
									base64IntToCharCode[Math.round(point.gain)]
								);
							}
						}

						// Push subfilters as well. Skip Index 0, is a copy of the base filter.
						let usingSubFilterBitfield: number = 0;
						for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
							usingSubFilterBitfield |= +(instrument.noteSubFilters[j + 1] != null) << j;
						}
						// Put subfilter usage into 2 chars (12 bits)
						buffer.push(
							base64IntToCharCode[usingSubFilterBitfield >> 6],
							base64IntToCharCode[usingSubFilterBitfield & 63]
						);
						// Put subfilter info in for all used subfilters
						for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
							if (usingSubFilterBitfield & (1 << j)) {
								buffer.push(base64IntToCharCode[instrument.noteSubFilters[j + 1]!.controlPointCount]);
								for (let k: number = 0; k < instrument.noteSubFilters[j + 1]!.controlPointCount; k++) {
									const point: FilterControlPoint =
										instrument.noteSubFilters[j + 1]!.controlPoints[k];
									buffer.push(
										base64IntToCharCode[point.type],
										base64IntToCharCode[Math.round(point.freq)],
										base64IntToCharCode[Math.round(point.gain)]
									);
								}
							}
						}
					}
				}
				if (effectsIncludeTransition(instrument.effects)) {
					buffer.push(base64IntToCharCode[instrument.transition]);
				}
				if (effectsIncludeChord(instrument.effects)) {
					buffer.push(base64IntToCharCode[instrument.chord]);
					// Custom arpeggio speed... only if the instrument arpeggiates.
					if (instrument.chord == Config.chords.dictionary["arpeggio"].index) {
						buffer.push(base64IntToCharCode[instrument.arpeggioSpeed]);
						buffer.push(base64IntToCharCode[+instrument.fastTwoNoteArp]); // Two note arp setting piggybacks on this
					}
				}
				if (effectsIncludePitchShift(instrument.effects)) {
					buffer.push(base64IntToCharCode[instrument.pitchShift]);
				}
				if (effectsIncludeDetune(instrument.effects)) {
					buffer.push(
						base64IntToCharCode[(instrument.detune - Config.detuneMin) >> 6],
						base64IntToCharCode[(instrument.detune - Config.detuneMin) & 63]
					);
				}
				if (effectsIncludeVibrato(instrument.effects)) {
					buffer.push(base64IntToCharCode[instrument.vibrato]);
					// Custom vibrato settings
					if (instrument.vibrato == Config.vibratos.length) {
						buffer.push(base64IntToCharCode[Math.round(instrument.vibratoDepth * 25)]);
						buffer.push(base64IntToCharCode[instrument.vibratoSpeed]);
						buffer.push(base64IntToCharCode[Math.round(instrument.vibratoDelay)]);
						buffer.push(base64IntToCharCode[instrument.vibratoType]);
					}
				}
				if (effectsIncludeDistortion(instrument.effects)) {
					buffer.push(base64IntToCharCode[instrument.distortion]);
					// Aliasing is tied into distortion for now
					buffer.push(base64IntToCharCode[+instrument.aliases]);
				}
				if (effectsIncludeBitcrusher(instrument.effects)) {
					buffer.push(
						base64IntToCharCode[instrument.bitcrusherFreq],
						base64IntToCharCode[instrument.bitcrusherQuantization]
					);
				}
				if (effectsIncludePanning(instrument.effects)) {
					buffer.push(base64IntToCharCode[instrument.pan >> 6], base64IntToCharCode[instrument.pan & 63]);
					buffer.push(base64IntToCharCode[instrument.panDelay]);
				}
				if (effectsIncludeChorus(instrument.effects)) {
					buffer.push(base64IntToCharCode[instrument.chorus]);
				}
				if (effectsIncludeEcho(instrument.effects)) {
					buffer.push(base64IntToCharCode[instrument.echoSustain], base64IntToCharCode[instrument.echoDelay]);
				}
				if (effectsIncludeReverb(instrument.effects)) {
					buffer.push(base64IntToCharCode[instrument.reverb]);
				}

				if (instrument.type != InstrumentType.drumset) {
					buffer.push(
						SongTagCode.fadeInOut,
						base64IntToCharCode[instrument.fadeIn],
						base64IntToCharCode[instrument.fadeOut]
					);
					// Transition info follows transition song tag
					buffer.push(base64IntToCharCode[+instrument.clicklessTransition]);
				}

				if (instrument.type == InstrumentType.harmonics || instrument.type == InstrumentType.pickedString) {
					buffer.push(SongTagCode.harmonics);
					const harmonicsBits: BitFieldWriter = new BitFieldWriter();
					for (let i: number = 0; i < Config.harmonicsControlPoints; i++) {
						harmonicsBits.write(Config.harmonicsControlPointBits, instrument.harmonicsWave.harmonics[i]);
					}
					harmonicsBits.encodeBase64(buffer);
				}

				if (instrument.type == InstrumentType.chip) {
					buffer.push(SongTagCode.wave, base64IntToCharCode[instrument.chipWave]);
					buffer.push(SongTagCode.unison, base64IntToCharCode[instrument.unison]);
				} else if (instrument.type == InstrumentType.fm) {
					buffer.push(SongTagCode.algorithm, base64IntToCharCode[instrument.algorithm]);
					buffer.push(SongTagCode.feedbackType, base64IntToCharCode[instrument.feedbackType]);
					buffer.push(SongTagCode.feedbackAmplitude, base64IntToCharCode[instrument.feedbackAmplitude]);

					buffer.push(SongTagCode.operatorFrequencies);
					for (let o: number = 0; o < Config.operatorCount; o++) {
						buffer.push(base64IntToCharCode[instrument.operators[o].frequency]);
					}
					buffer.push(SongTagCode.operatorAmplitudes);
					for (let o: number = 0; o < Config.operatorCount; o++) {
						buffer.push(base64IntToCharCode[instrument.operators[o].amplitude]);
					}

					buffer.push(SongTagCode.operatorWaves);
					for (let o: number = 0; o < Config.operatorCount; o++) {
						buffer.push(base64IntToCharCode[instrument.operators[o].waveform]);
						// Push pulse width if that type is used
						if (instrument.operators[o].waveform == 3) {
							buffer.push(base64IntToCharCode[instrument.operators[o].pulseWidth]);
						}
					}
				} else if (instrument.type == InstrumentType.customChipWave) {
					buffer.push(SongTagCode.wave, base64IntToCharCode[instrument.chipWave]);
					buffer.push(SongTagCode.unison, base64IntToCharCode[instrument.unison]);
					buffer.push(SongTagCode.customChipWave);
					// Push custom wave values
					for (let j: number = 0; j < 64; j++) {
						buffer.push(base64IntToCharCode[(instrument.customChipWave[j] + 24) as number]);
					}
				} else if (instrument.type == InstrumentType.noise) {
					buffer.push(SongTagCode.wave, base64IntToCharCode[instrument.chipNoise]);
				} else if (instrument.type == InstrumentType.spectrum) {
					buffer.push(SongTagCode.spectrum);
					const spectrumBits: BitFieldWriter = new BitFieldWriter();
					for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
						spectrumBits.write(Config.spectrumControlPointBits, instrument.spectrumWave.spectrum[i]);
					}
					spectrumBits.encodeBase64(buffer);
				} else if (instrument.type == InstrumentType.drumset) {
					buffer.push(SongTagCode.drumsetEnvelopes);
					for (let j: number = 0; j < Config.drumCount; j++) {
						buffer.push(base64IntToCharCode[instrument.drumsetEnvelopes[j]]);
					}

					buffer.push(SongTagCode.spectrum);
					const spectrumBits: BitFieldWriter = new BitFieldWriter();
					for (let j: number = 0; j < Config.drumCount; j++) {
						for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
							spectrumBits.write(
								Config.spectrumControlPointBits,
								instrument.drumsetSpectrumWaves[j].spectrum[i]
							);
						}
					}
					spectrumBits.encodeBase64(buffer);
				} else if (instrument.type == InstrumentType.harmonics) {
					buffer.push(SongTagCode.unison, base64IntToCharCode[instrument.unison]);
				} else if (instrument.type == InstrumentType.pwm) {
					buffer.push(SongTagCode.pulseWidth, base64IntToCharCode[instrument.pulseWidth]);
				} else if (instrument.type == InstrumentType.pickedString) {
					buffer.push(SongTagCode.unison, base64IntToCharCode[instrument.unison]);
					buffer.push(SongTagCode.stringSustain, base64IntToCharCode[instrument.stringSustain]);
				} else if (instrument.type == InstrumentType.mod) {
					// Handled down below. Could be moved, but meh.
				} else {
					throw new Error("Unknown instrument type.");
				}

				buffer.push(SongTagCode.envelopes, base64IntToCharCode[instrument.envelopeCount]);
				for (let envelopeIndex: number = 0; envelopeIndex < instrument.envelopeCount; envelopeIndex++) {
					buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].target]);
					if (Config.instrumentAutomationTargets[instrument.envelopes[envelopeIndex].target].maxCount > 1) {
						buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].index]);
					}
					buffer.push(base64IntToCharCode[instrument.envelopes[envelopeIndex].envelope]);
				}
			}
		}

		buffer.push(SongTagCode.bars);
		bits = new BitFieldWriter();
		let neededBits: number = 0;
		while (1 << neededBits < this.patternsPerChannel + 1) neededBits++;
		for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++)
			for (let i: number = 0; i < this.barCount; i++) {
				bits.write(neededBits, this.channels[channelIndex].bars[i]);
			}
		bits.encodeBase64(buffer);

		buffer.push(SongTagCode.patterns);
		bits = new BitFieldWriter();
		const shapeBits: BitFieldWriter = new BitFieldWriter();
		const bitsPerNoteSize: number = Song.getNeededBits(Config.noteSizeMax);
		for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
			const channel: Channel = this.channels[channelIndex];
			const maxInstrumentsPerPattern: number = this.getMaxInstrumentsPerPattern(channelIndex);
			const isNoiseChannel: boolean = this.getChannelIsNoise(channelIndex);
			const isModChannel: boolean = this.getChannelIsMod(channelIndex);
			const neededInstrumentCountBits: number = Song.getNeededBits(
				maxInstrumentsPerPattern - Config.instrumentCountMin
			);
			const neededInstrumentIndexBits: number = Song.getNeededBits(channel.instruments.length - 1);

			// Some info about modulator settings immediately follows in mod channels.
			if (isModChannel) {
				const neededModInstrumentIndexBits: number = Song.getNeededBits(this.getMaxInstrumentsPerChannel() + 2);
				for (let instrumentIndex: number = 0; instrumentIndex < channel.instruments.length; instrumentIndex++) {
					let instrument: Instrument = this.channels[channelIndex].instruments[instrumentIndex];

					for (let mod: number = 0; mod < Config.modCount; mod++) {
						const modChannel: number = instrument.modChannels[mod];
						const modInstrument: number = instrument.modInstruments[mod];
						const modSetting: number = instrument.modulators[mod];
						const modFilter: number = instrument.modFilterTypes[mod];

						// Still using legacy "mod status" format, but doing it manually as it's only used in the URL now.
						// 0 - For pitch/noise
						// 1 - (used to be For noise, not needed)
						// 2 - For song
						// 3 - None
						let status: number = Config.modulators[modSetting].forSong ? 2 : 0;
						if (modSetting == Config.modulators.dictionary["none"].index) status = 3;

						bits.write(2, status);

						// Channel/Instrument is only used if the status isn't "song" or "none".
						if (status == 0 || status == 1) {
							bits.write(8, modChannel);
							bits.write(neededModInstrumentIndexBits, modInstrument);
						}

						// Only used if setting isn't "none".
						if (status != 3) {
							bits.write(6, modSetting);
						}

						// Write mod filter info, only if this is a filter mod
						if (
							Config.modulators[instrument.modulators[mod]].name == "eq filter" ||
							Config.modulators[instrument.modulators[mod]].name == "note filter"
						) {
							bits.write(6, modFilter);
						}
					}
				}
			}
			const octaveOffset: number = isNoiseChannel || isModChannel ? 0 : channel.octave * Config.pitchesPerOctave;
			let lastPitch: number = isNoiseChannel ? 4 : octaveOffset;
			const recentPitches: number[] = isModChannel
				? [0, 1, 2, 3, 4, 5]
				: isNoiseChannel
				? [4, 6, 7, 2, 3, 8, 0, 10]
				: [0, 7, 12, 19, 24, -5, -12];
			const recentShapes: string[] = [];
			for (let i: number = 0; i < recentPitches.length; i++) {
				recentPitches[i] += octaveOffset;
			}
			for (const pattern of channel.patterns) {
				if (this.patternInstruments) {
					const instrumentCount: number = validateRange(
						Config.instrumentCountMin,
						maxInstrumentsPerPattern,
						pattern.instruments.length
					);
					bits.write(neededInstrumentCountBits, instrumentCount - Config.instrumentCountMin);
					for (let i: number = 0; i < instrumentCount; i++) {
						bits.write(neededInstrumentIndexBits, pattern.instruments[i]);
					}
				}

				if (pattern.notes.length > 0) {
					bits.write(1, 1);

					let curPart: number = 0;
					for (const note of pattern.notes) {
						// For mod channels, a negative offset may be necessary.
						if (note.start < curPart && isModChannel) {
							bits.write(2, 0); // rest, then...
							bits.write(1, 1); // negative offset
							bits.writePartDuration(curPart - note.start);
						}

						if (note.start > curPart) {
							bits.write(2, 0); // rest
							if (isModChannel) bits.write(1, 0); // positive offset, only needed for mod channels
							bits.writePartDuration(note.start - curPart);
						}

						shapeBits.clear();

						// Old format was:
						// 0: 1 pitch, 10: 2 pitches, 110: 3 pitches, 111: 4 pitches
						// New format is:
						//      0: 1 pitch
						// 1[XXX]: 3 bits of binary signifying 2+ pitches
						if (note.pitches.length == 1) {
							shapeBits.write(1, 0);
						} else {
							shapeBits.write(1, 1);
							shapeBits.write(3, note.pitches.length - 2);
						}

						shapeBits.writePinCount(note.pins.length - 1);

						if (!isModChannel) {
							shapeBits.write(bitsPerNoteSize, note.pins[0].size); // volume
						} else {
							shapeBits.write(9, note.pins[0].size); // Modulator value. 9 bits for now = 512 max mod value?
						}

						let shapePart: number = 0;
						let startPitch: number = note.pitches[0];
						let currentPitch: number = startPitch;
						const pitchBends: number[] = [];
						for (let i: number = 1; i < note.pins.length; i++) {
							const pin: NotePin = note.pins[i];
							const nextPitch: number = startPitch + pin.interval;
							if (currentPitch != nextPitch) {
								shapeBits.write(1, 1);
								pitchBends.push(nextPitch);
								currentPitch = nextPitch;
							} else {
								shapeBits.write(1, 0);
							}
							shapeBits.writePartDuration(pin.time - shapePart);
							shapePart = pin.time;
							if (!isModChannel) {
								shapeBits.write(bitsPerNoteSize, pin.size);
							} else {
								shapeBits.write(9, pin.size);
							}
						}

						const shapeString: string = String.fromCharCode.apply(null, shapeBits.encodeBase64([]));
						const shapeIndex: number = recentShapes.indexOf(shapeString);
						if (shapeIndex == -1) {
							bits.write(2, 1); // new shape
							bits.concat(shapeBits);
						} else {
							bits.write(1, 1); // old shape
							bits.writeLongTail(0, 0, shapeIndex);
							recentShapes.splice(shapeIndex, 1);
						}
						recentShapes.unshift(shapeString);
						if (recentShapes.length > 10) recentShapes.pop();

						const allPitches: number[] = note.pitches.concat(pitchBends);
						for (let i: number = 0; i < allPitches.length; i++) {
							const pitch: number = allPitches[i];
							const pitchIndex: number = recentPitches.indexOf(pitch);
							if (pitchIndex == -1) {
								let interval: number = 0;
								let pitchIter: number = lastPitch;
								if (pitchIter < pitch) {
									while (pitchIter != pitch) {
										pitchIter++;
										if (recentPitches.indexOf(pitchIter) == -1) interval++;
									}
								} else {
									while (pitchIter != pitch) {
										pitchIter--;
										if (recentPitches.indexOf(pitchIter) == -1) interval--;
									}
								}
								bits.write(1, 0);
								bits.writePitchInterval(interval);
							} else {
								bits.write(1, 1);
								bits.write(4, pitchIndex);
								recentPitches.splice(pitchIndex, 1);
							}
							recentPitches.unshift(pitch);
							if (recentPitches.length > 16) recentPitches.pop();

							if (i == note.pitches.length - 1) {
								lastPitch = note.pitches[0];
							} else {
								lastPitch = pitch;
							}
						}

						if (note.start == 0) {
							bits.write(1, note.continuesLastPattern ? 1 : 0);
						}

						curPart = note.end;
					}

					if (curPart < this.beatsPerBar * Config.partsPerBeat + +isModChannel) {
						bits.write(2, 0); // rest
						if (isModChannel) bits.write(1, 0); // positive offset
						bits.writePartDuration(this.beatsPerBar * Config.partsPerBeat + +isModChannel - curPart);
					}
				} else {
					bits.write(1, 0);
				}
			}
		}
		let stringLength: number = bits.lengthBase64();
		let digits: number[] = [];
		while (stringLength > 0) {
			digits.unshift(base64IntToCharCode[stringLength & 63]);
			stringLength = stringLength >> 6;
		}
		buffer.push(base64IntToCharCode[digits.length]);
		Array.prototype.push.apply(buffer, digits); // append digits to buffer.
		bits.encodeBase64(buffer);

		const maxApplyArgs: number = 64000;
		if (buffer.length < maxApplyArgs) {
			// Note: Function.apply may break for long argument lists.
			return String.fromCharCode.apply(null, buffer);
		} else {
			let result: string = "";
			for (let i: number = 0; i < buffer.length; i += maxApplyArgs) {
				result += String.fromCharCode.apply(null, buffer.slice(i, i + maxApplyArgs));
			}
			return result;
		}
	}

	private static _envelopeFromLegacyIndex(legacyIndex: number): Envelope {
		// I swapped the order of "custom"/"steady", now "none"/"note size".
		if (legacyIndex == 0) legacyIndex = 1;
		else if (legacyIndex == 1) legacyIndex = 0;
		return Config.envelopes[clamp(0, Config.envelopes.length, legacyIndex)];
	}

	public fromBase64String(compressed: string): void {
		if (compressed == null || compressed == "") {
			this.initToDefault(true);
			return;
		}
		let charIndex: number = 0;
		// skip whitespace.
		while (compressed.charCodeAt(charIndex) <= CharCode.SPACE) charIndex++;
		// skip hash mark.
		if (compressed.charCodeAt(charIndex) == CharCode.HASH) charIndex++;
		// if it starts with curly brace, treat it as JSON.
		if (compressed.charCodeAt(charIndex) == CharCode.LEFT_CURLY_BRACE) {
			this.fromJsonObject(JSON.parse(charIndex == 0 ? compressed : compressed.substring(charIndex)));
			return;
		}

		const variantTest: number = compressed.charCodeAt(charIndex);
		let fromBeepBox: boolean;
		let fromJummBox: boolean;

		// Detect variant here. If version doesn't match known variant, assume it is a vanilla string which does not report variant.
		if (variantTest == 106) {
			//"j"
			fromBeepBox = false;
			fromJummBox = true;
			charIndex++;
		} else {
			fromBeepBox = true;
			fromJummBox = false;
		}

		const version: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
		if (
			fromBeepBox &&
			(version == -1 || version > Song._latestBeepboxVersion || version < Song._oldestBeepboxVersion)
		)
			return;
		if (
			fromJummBox &&
			(version == -1 || version > Song._latestJummBoxVersion || version < Song._oldestJummBoxVersion)
		)
			return;
		const beforeTwo: boolean = version < 2;
		const beforeThree: boolean = version < 3;
		const beforeFour: boolean = version < 4;
		const beforeFive: boolean = version < 5;
		const beforeSix: boolean = version < 6;
		const beforeSeven: boolean = version < 7;
		const beforeEight: boolean = version < 8;
		const beforeNine: boolean = version < 9;
		this.initToDefault((fromBeepBox && beforeNine) || (fromJummBox && beforeFive));
		const forceSimpleFilter: boolean = (fromBeepBox && beforeNine) || (fromJummBox && beforeFive);

		if (beforeThree && fromBeepBox) {
			// Originally, the only instrument transition was "instant" and the only drum wave was "retro".
			for (const channel of this.channels) {
				channel.instruments[0].transition = Config.transitions.dictionary["interrupt"].index;
				channel.instruments[0].effects |= 1 << EffectType.transition;
			}
			this.channels[3].instruments[0].chipNoise = 0;
		}

		let legacySettingsCache: LegacySettings[][] | null = null;
		if ((fromBeepBox && beforeNine) || (fromJummBox && beforeFive)) {
			// Unfortunately, old versions of BeepBox had a variety of different ways of saving
			// filter-and-envelope-related parameters in the URL, and none of them directly
			// correspond to the new way of saving these parameters. We can approximate the old
			// settings by collecting all the old settings for an instrument and passing them to
			// convertLegacySettings(), so I use this data structure to collect the settings
			// for each instrument if necessary.
			legacySettingsCache = [];
			for (let i: number = legacySettingsCache.length; i < this.getChannelCount(); i++) {
				legacySettingsCache[i] = [];
				for (let j: number = 0; j < Config.instrumentCountMin; j++) legacySettingsCache[i][j] = {};
			}
		}

		let legacyGlobalReverb: number = 0; // beforeNine reverb was song-global, record that reverb here and adapt it to instruments as needed.

		let instrumentChannelIterator: number = 0;
		let instrumentIndexIterator: number = -1;
		let command: number;
		let useSlowerArpSpeed: boolean = false;
		let useFastTwoNoteArp: boolean = false;
		while (charIndex < compressed.length)
			switch ((command = compressed.charCodeAt(charIndex++))) {
				case SongTagCode.songTitle:
					{
						// Length of song name string
						var songNameLength =
							(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) +
							base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
						this.title = decodeURIComponent(compressed.substring(charIndex, charIndex + songNameLength));
						document.title = this.title + " - " + EditorConfig.versionDisplayName;

						charIndex += songNameLength;
					}
					break;
				case SongTagCode.channelCount:
					{
						this.pitchChannelCount = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
						this.noiseChannelCount = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
						if (fromBeepBox || beforeTwo) {
							// No mod channel support before jummbox v2
							this.modChannelCount = 0;
						} else {
							this.modChannelCount = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
						}
						this.pitchChannelCount = validateRange(
							Config.pitchChannelCountMin,
							Config.pitchChannelCountMax,
							this.pitchChannelCount
						);
						this.noiseChannelCount = validateRange(
							Config.noiseChannelCountMin,
							Config.noiseChannelCountMax,
							this.noiseChannelCount
						);
						this.modChannelCount = validateRange(
							Config.modChannelCountMin,
							Config.modChannelCountMax,
							this.modChannelCount
						);

						for (
							let channelIndex = this.channels.length;
							channelIndex < this.getChannelCount();
							channelIndex++
						) {
							this.channels[channelIndex] = new Channel();
						}
						this.channels.length = this.getChannelCount();
						if ((fromBeepBox && beforeNine) || (fromJummBox && beforeFive)) {
							for (let i: number = legacySettingsCache!.length; i < this.getChannelCount(); i++) {
								legacySettingsCache![i] = [];
								for (let j: number = 0; j < Config.instrumentCountMin; j++)
									legacySettingsCache![i][j] = {};
							}
						}
					}
					break;
				case SongTagCode.scale:
					{
						this.scale = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
						// All the scales were jumbled around by Jummbox. Just convert to free.
						if (fromBeepBox) this.scale = 0;
					}
					break;
				case SongTagCode.key:
					{
						if (beforeSeven && fromBeepBox) {
							this.key = clamp(
								0,
								Config.keys.length,
								11 - base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
						} else {
							this.key = clamp(
								0,
								Config.keys.length,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
						}
					}
					break;
				case SongTagCode.loopStart:
					{
						if (beforeFive && fromBeepBox) {
							this.loopStart = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
						} else {
							this.loopStart =
								(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) +
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
						}
					}
					break;
				case SongTagCode.loopEnd:
					{
						if (beforeFive && fromBeepBox) {
							this.loopLength = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
						} else {
							this.loopLength =
								(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) +
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)] +
								1;
						}
					}
					break;
				case SongTagCode.tempo:
					{
						if (beforeFour && fromBeepBox) {
							this.tempo = [95, 120, 151, 190][base64CharCodeToInt[compressed.charCodeAt(charIndex++)]];
						} else if (beforeSeven && fromBeepBox) {
							this.tempo = [88, 95, 103, 111, 120, 130, 140, 151, 163, 176, 190, 206, 222, 240, 259][
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							];
						} else {
							this.tempo =
								(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) |
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
						}
						this.tempo = clamp(Config.tempoMin, Config.tempoMax + 1, this.tempo);
					}
					break;
				case SongTagCode.reverb:
					{
						if (beforeNine && fromBeepBox) {
							legacyGlobalReverb = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 12;
							legacyGlobalReverb = clamp(0, Config.reverbRange, legacyGlobalReverb);
						} else if (beforeFive && fromJummBox) {
							legacyGlobalReverb = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							legacyGlobalReverb = clamp(0, Config.reverbRange, legacyGlobalReverb);
						} else {
							// Do nothing, BeepBox v9+ do not support song-wide reverb - JummBox still does via modulator.
						}
					}
					break;
				case SongTagCode.beatCount:
					{
						if (beforeThree && fromBeepBox) {
							this.beatsPerBar = [6, 7, 8, 9, 10][
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							];
						} else {
							this.beatsPerBar = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1;
						}
						this.beatsPerBar = Math.max(
							Config.beatsPerBarMin,
							Math.min(Config.beatsPerBarMax, this.beatsPerBar)
						);
					}
					break;
				case SongTagCode.barCount:
					{
						const barCount: number =
							(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) +
							base64CharCodeToInt[compressed.charCodeAt(charIndex++)] +
							1;
						this.barCount = validateRange(Config.barCountMin, Config.barCountMax, barCount);
						for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
							for (let bar = this.channels[channelIndex].bars.length; bar < this.barCount; bar++) {
								this.channels[channelIndex].bars[bar] = bar < 4 ? 1 : 0;
							}
							this.channels[channelIndex].bars.length = this.barCount;
						}
					}
					break;
				case SongTagCode.patternCount:
					{
						let patternsPerChannel: number;
						if (beforeEight && fromBeepBox) {
							patternsPerChannel = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1;
						} else {
							patternsPerChannel =
								(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) +
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)] +
								1;
						}
						this.patternsPerChannel = validateRange(1, Config.barCountMax, patternsPerChannel);
						const channelCount: number = this.getChannelCount();
						for (let channelIndex: number = 0; channelIndex < channelCount; channelIndex++) {
							const patterns: Pattern[] = this.channels[channelIndex].patterns;
							for (let pattern = patterns.length; pattern < this.patternsPerChannel; pattern++) {
								patterns[pattern] = new Pattern();
							}
							patterns.length = this.patternsPerChannel;
						}
					}
					break;
				case SongTagCode.instrumentCount:
					{
						if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							const instrumentsPerChannel: number = validateRange(
								Config.instrumentCountMin,
								Config.patternInstrumentCountMax,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + Config.instrumentCountMin
							);
							this.layeredInstruments = false;
							this.patternInstruments = instrumentsPerChannel > 1;

							for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
								const isNoiseChannel: boolean =
									channelIndex >= this.pitchChannelCount &&
									channelIndex < this.pitchChannelCount + this.noiseChannelCount;
								const isModChannel: boolean =
									channelIndex >= this.pitchChannelCount + this.noiseChannelCount;

								for (
									let instrumentIndex: number = this.channels[channelIndex].instruments.length;
									instrumentIndex < instrumentsPerChannel;
									instrumentIndex++
								) {
									this.channels[channelIndex].instruments[instrumentIndex] = new Instrument(
										isNoiseChannel,
										isModChannel
									);
								}
								this.channels[channelIndex].instruments.length = instrumentsPerChannel;
								if (beforeSix && fromBeepBox) {
									for (
										let instrumentIndex: number = 0;
										instrumentIndex < instrumentsPerChannel;
										instrumentIndex++
									) {
										this.channels[channelIndex].instruments[instrumentIndex].setTypeAndReset(
											isNoiseChannel ? InstrumentType.noise : InstrumentType.chip,
											isNoiseChannel,
											isModChannel
										);
									}
								}

								for (
									let j: number = legacySettingsCache![channelIndex].length;
									j < instrumentsPerChannel;
									j++
								) {
									legacySettingsCache![channelIndex][j] = {};
								}
							}
						} else {
							const instrumentsFlagBits: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							this.layeredInstruments = (instrumentsFlagBits & (1 << 1)) != 0;
							this.patternInstruments = (instrumentsFlagBits & (1 << 0)) != 0;
							for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
								let instrumentCount: number = 1;
								if (this.layeredInstruments || this.patternInstruments) {
									instrumentCount = validateRange(
										Config.instrumentCountMin,
										this.getMaxInstrumentsPerChannel(),
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)] +
											Config.instrumentCountMin
									);
								}
								const channel: Channel = this.channels[channelIndex];
								const isNoiseChannel: boolean = this.getChannelIsNoise(channelIndex);
								const isModChannel: boolean = this.getChannelIsMod(channelIndex);
								for (let i: number = channel.instruments.length; i < instrumentCount; i++) {
									channel.instruments[i] = new Instrument(isNoiseChannel, isModChannel);
								}
								channel.instruments.length = instrumentCount;
							}
						}
					}
					break;
				case SongTagCode.rhythm:
					{
						this.rhythm = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
						// Port all arpeggio speeds over to match what they were, before arpeggio speed was decoupled from rhythm.
						if ((fromJummBox && beforeThree) || fromBeepBox) {
							// These are all the rhythms that had 4 ticks/arpeggio instead of 3.
							if (
								this.rhythm == Config.rhythms.dictionary["÷3 (triplets)"].index ||
								this.rhythm == Config.rhythms.dictionary["÷6"].index
							) {
								useSlowerArpSpeed = true;
							}
							// Use faster two note arp on these rhythms
							if (this.rhythm >= Config.rhythms.dictionary["÷6"].index) {
								useFastTwoNoteArp = true;
							}
						}
					}
					break;
				case SongTagCode.channelOctave:
					{
						if (beforeThree && fromBeepBox) {
							const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							this.channels[channelIndex].octave = clamp(
								0,
								Config.pitchOctaves,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1
							);
							if (channelIndex >= this.pitchChannelCount) this.channels[channelIndex].octave = 0;
						} else if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
								this.channels[channelIndex].octave = clamp(
									0,
									Config.pitchOctaves,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1
								);
								if (channelIndex >= this.pitchChannelCount) this.channels[channelIndex].octave = 0;
							}
						} else {
							for (let channelIndex: number = 0; channelIndex < this.pitchChannelCount; channelIndex++) {
								this.channels[channelIndex].octave = clamp(
									0,
									Config.pitchOctaves,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
							}
							for (
								let channelIndex: number = this.pitchChannelCount;
								channelIndex < this.getChannelCount();
								channelIndex++
							) {
								this.channels[channelIndex].octave = 0;
							}
						}
					}
					break;
				case SongTagCode.startInstrument:
					{
						instrumentIndexIterator++;
						if (instrumentIndexIterator >= this.channels[instrumentChannelIterator].instruments.length) {
							instrumentChannelIterator++;
							instrumentIndexIterator = 0;
						}
						validateRange(0, this.channels.length - 1, instrumentChannelIterator);
						const instrument: Instrument =
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
						// JB before v5 had custom chip in the place where pickedString is now, and mod one sooner as well. New index is +1 for both.
						let instrumentType: number = validateRange(
							0,
							InstrumentType.length - 1,
							base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
						);
						if (fromJummBox && beforeFive) {
							if (instrumentType == InstrumentType.pickedString) {
								instrumentType = InstrumentType.customChipWave;
							} else if (instrumentType == InstrumentType.customChipWave) {
								instrumentType = InstrumentType.mod;
							}
						}
						instrument.setTypeAndReset(
							instrumentType,
							instrumentChannelIterator >= this.pitchChannelCount &&
								instrumentChannelIterator < this.pitchChannelCount + this.noiseChannelCount,
							instrumentChannelIterator >= this.pitchChannelCount + this.noiseChannelCount
						);

						// Anti-aliasing was added in BeepBox 3.0 (v6->v7) and JummBox 1.3 (v1->v2 roughly but some leakage possible)
						if (
							((beforeSeven && fromBeepBox) || (beforeTwo && fromJummBox)) &&
							(instrumentType == InstrumentType.chip ||
								instrumentType == InstrumentType.customChipWave ||
								instrumentType == InstrumentType.pwm)
						) {
							instrument.aliases = true;
							instrument.distortion = 0;
							instrument.effects |= 1 << EffectType.distortion;
						}
						if (useSlowerArpSpeed) {
							instrument.arpeggioSpeed = 9; // x3/4 speed. This used to be tied to rhythm, but now it is decoupled to each instrument's arp speed slider. This flag gets set when importing older songs to keep things consistent.
						}
						if (useFastTwoNoteArp) {
							instrument.fastTwoNoteArp = true;
						}

						if (beforeSeven && fromBeepBox) {
							instrument.effects = 0;
							// Chip/noise instruments had arpeggio and FM had custom interval but neither
							// explicitly saved the chorus setting beforeSeven so enable it here.
							if (instrument.chord != Config.chords.dictionary["simultaneous"].index) {
								// Enable chord if it was used.
								instrument.effects |= 1 << EffectType.chord;
							}
						}
					}
					break;
				case SongTagCode.preset:
					{
						const presetValue: number =
							(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) |
							base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
						this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].preset =
							presetValue;
						// Picked string was inserted before custom chip in JB v5, so bump up preset index.
						if (fromJummBox && beforeFive) {
							if (
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].preset ==
								InstrumentType.pickedString
							) {
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].preset =
									InstrumentType.customChipWave;
							}
						}
					}
					break;
				case SongTagCode.wave:
					{
						if (beforeThree && fromBeepBox) {
							const legacyWaves: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 0];
							const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							const instrument: Instrument = this.channels[channelIndex].instruments[0];
							instrument.chipWave = clamp(
								0,
								Config.chipWaves.length,
								legacyWaves[base64CharCodeToInt[compressed.charCodeAt(charIndex++)]] | 0
							);

							// Version 2 didn't save any settings for settings for filters, or envelopes,
							// just waves, so initialize them here I guess.
							instrument.convertLegacySettings(legacySettingsCache![channelIndex][0], forceSimpleFilter);
						} else if (beforeSix && fromBeepBox) {
							const legacyWaves: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 0];
							for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
								for (const instrument of this.channels[channelIndex].instruments) {
									if (channelIndex >= this.pitchChannelCount) {
										instrument.chipNoise = clamp(
											0,
											Config.chipNoises.length,
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										);
									} else {
										instrument.chipWave = clamp(
											0,
											Config.chipWaves.length,
											legacyWaves[base64CharCodeToInt[compressed.charCodeAt(charIndex++)]] | 0
										);
									}
								}
							}
						} else if (beforeSeven && fromBeepBox) {
							const legacyWaves: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 0];
							if (instrumentChannelIterator >= this.pitchChannelCount) {
								this.channels[instrumentChannelIterator].instruments[
									instrumentIndexIterator
								].chipNoise = clamp(
									0,
									Config.chipNoises.length,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
							} else {
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave =
									clamp(
										0,
										Config.chipWaves.length,
										legacyWaves[base64CharCodeToInt[compressed.charCodeAt(charIndex++)]] | 0
									);
							}
						} else {
							if (instrumentChannelIterator >= this.pitchChannelCount) {
								this.channels[instrumentChannelIterator].instruments[
									instrumentIndexIterator
								].chipNoise = clamp(
									0,
									Config.chipNoises.length,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
							} else {
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chipWave =
									clamp(
										0,
										Config.chipWaves.length,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
							}
						}
					}
					break;
				case SongTagCode.eqFilter:
					{
						if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							if (beforeSeven && fromBeepBox) {
								const legacyToCutoff: number[] = [10, 6, 3, 0, 8, 5, 2];
								const legacyToEnvelope: string[] = [
									"none",
									"none",
									"none",
									"none",
									"decay 1",
									"decay 2",
									"decay 3"
								];

								if (beforeThree && fromBeepBox) {
									const channelIndex: number =
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
									const instrument: Instrument = this.channels[channelIndex].instruments[0];
									const legacySettings: LegacySettings = legacySettingsCache![channelIndex][0];
									const legacyFilter: number = [1, 3, 4, 5][
										clamp(
											0,
											legacyToCutoff.length,
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										)
									];
									legacySettings.filterCutoff = legacyToCutoff[legacyFilter];
									legacySettings.filterResonance = 0;
									legacySettings.filterEnvelope =
										Config.envelopes.dictionary[legacyToEnvelope[legacyFilter]];
									instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
								} else if (beforeSix && fromBeepBox) {
									for (
										let channelIndex: number = 0;
										channelIndex < this.getChannelCount();
										channelIndex++
									) {
										for (
											let i: number = 0;
											i < this.channels[channelIndex].instruments.length;
											i++
										) {
											const instrument: Instrument = this.channels[channelIndex].instruments[i];
											const legacySettings: LegacySettings =
												legacySettingsCache![channelIndex][i];
											const legacyFilter: number = clamp(
												0,
												legacyToCutoff.length,
												base64CharCodeToInt[compressed.charCodeAt(charIndex++)] + 1
											);
											if (channelIndex < this.pitchChannelCount) {
												legacySettings.filterCutoff = legacyToCutoff[legacyFilter];
												legacySettings.filterResonance = 0;
												legacySettings.filterEnvelope =
													Config.envelopes.dictionary[legacyToEnvelope[legacyFilter]];
											} else {
												legacySettings.filterCutoff = 10;
												legacySettings.filterResonance = 0;
												legacySettings.filterEnvelope = Config.envelopes.dictionary["none"];
											}
											instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
										}
									}
								} else {
									const legacyFilter: number = clamp(
										0,
										legacyToCutoff.length,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
									const instrument: Instrument =
										this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
									const legacySettings: LegacySettings =
										legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
									legacySettings.filterCutoff = legacyToCutoff[legacyFilter];
									legacySettings.filterResonance = 0;
									legacySettings.filterEnvelope =
										Config.envelopes.dictionary[legacyToEnvelope[legacyFilter]];
									instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
								}
							} else {
								const filterCutoffRange: number = 11;
								const instrument: Instrument =
									this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
								const legacySettings: LegacySettings =
									legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
								legacySettings.filterCutoff = clamp(
									0,
									filterCutoffRange,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
								instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
							}
						} else {
							const instrument: Instrument =
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
							let typeCheck: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];

							if (fromBeepBox || typeCheck == 0) {
								instrument.eqFilterType = false;
								if (fromJummBox) typeCheck = base64CharCodeToInt[compressed.charCodeAt(charIndex++)]; // Skip to next to get control point count
								const originalControlPointCount: number = typeCheck;
								instrument.eqFilter.controlPointCount = clamp(
									0,
									Config.filterMaxPoints + 1,
									originalControlPointCount
								);
								for (
									let i: number = instrument.eqFilter.controlPoints.length;
									i < instrument.eqFilter.controlPointCount;
									i++
								) {
									instrument.eqFilter.controlPoints[i] = new FilterControlPoint();
								}
								for (let i: number = 0; i < instrument.eqFilter.controlPointCount; i++) {
									const point: FilterControlPoint = instrument.eqFilter.controlPoints[i];
									point.type = clamp(
										0,
										FilterType.length,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
									point.freq = clamp(
										0,
										Config.filterFreqRange,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
									point.gain = clamp(
										0,
										Config.filterGainRange,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
								}
								for (
									let i: number = instrument.eqFilter.controlPointCount;
									i < originalControlPointCount;
									i++
								) {
									charIndex += 3;
								}

								// Get subfilters as well. Skip Index 0, is a copy of the base filter.
								instrument.eqSubFilters[0] = instrument.eqFilter;
								if (fromJummBox && !beforeFive) {
									let usingSubFilterBitfield: number =
										(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) |
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
									for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
										if (usingSubFilterBitfield & (1 << j)) {
											// Number of control points
											const originalSubfilterControlPointCount: number =
												base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
											if (instrument.eqSubFilters[j + 1] == null)
												instrument.eqSubFilters[j + 1] = new FilterSettings();
											instrument.eqSubFilters[j + 1]!.controlPointCount = clamp(
												0,
												Config.filterMaxPoints + 1,
												originalSubfilterControlPointCount
											);
											for (
												let i: number = instrument.eqSubFilters[j + 1]!.controlPoints.length;
												i < instrument.eqSubFilters[j + 1]!.controlPointCount;
												i++
											) {
												instrument.eqSubFilters[j + 1]!.controlPoints[i] =
													new FilterControlPoint();
											}
											for (
												let i: number = 0;
												i < instrument.eqSubFilters[j + 1]!.controlPointCount;
												i++
											) {
												const point: FilterControlPoint =
													instrument.eqSubFilters[j + 1]!.controlPoints[i];
												point.type = clamp(
													0,
													FilterType.length,
													base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
												);
												point.freq = clamp(
													0,
													Config.filterFreqRange,
													base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
												);
												point.gain = clamp(
													0,
													Config.filterGainRange,
													base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
												);
											}
											for (
												let i: number = instrument.eqSubFilters[j + 1]!.controlPointCount;
												i < originalSubfilterControlPointCount;
												i++
											) {
												charIndex += 3;
											}
										}
									}
								}
							} else {
								instrument.eqFilterType = true;
								instrument.eqFilterSimpleCut = clamp(
									0,
									Config.filterSimpleCutRange,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
								instrument.eqFilterSimplePeak = clamp(
									0,
									Config.filterSimplePeakRange,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
							}
						}
					}
					break;
				case SongTagCode.filterResonance:
					{
						if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							const filterResonanceRange: number = 8;
							const instrument: Instrument =
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
							const legacySettings: LegacySettings =
								legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
							legacySettings.filterResonance = clamp(
								0,
								filterResonanceRange,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
							instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
						} else {
							// Do nothing? This song tag code is deprecated for now.
						}
					}
					break;
				case SongTagCode.drumsetEnvelopes:
					{
						const instrument: Instrument =
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
						if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							if (instrument.type == InstrumentType.drumset) {
								for (let i: number = 0; i < Config.drumCount; i++) {
									instrument.drumsetEnvelopes[i] = Song._envelopeFromLegacyIndex(
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									).index;
								}
							} else {
								// This used to be used for general filter envelopes.
								// The presence of an envelope affects how convertLegacySettings
								// decides the closest possible approximation, so update it.
								const legacySettings: LegacySettings =
									legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
								legacySettings.filterEnvelope = Song._envelopeFromLegacyIndex(
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
								instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
							}
						} else {
							// This tag is now only used for drumset filter envelopes.
							for (let i: number = 0; i < Config.drumCount; i++) {
								instrument.drumsetEnvelopes[i] = clamp(
									0,
									Config.envelopes.length,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
							}
						}
					}
					break;
				case SongTagCode.pulseWidth:
					{
						const instrument: Instrument =
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
						instrument.pulseWidth = clamp(
							0,
							Config.pulseWidthRange + +fromJummBox,
							base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
						);
						if (fromBeepBox) {
							// BeepBox formula
							instrument.pulseWidth = Math.round(
								Math.pow(0.5, (7 - instrument.pulseWidth) * Config.pulseWidthStepPower) *
									Config.pulseWidthRange
							);
						}

						if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							const legacySettings: LegacySettings =
								legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
							legacySettings.pulseEnvelope = Song._envelopeFromLegacyIndex(
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
							instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
						}
					}
					break;
				case SongTagCode.stringSustain:
					{
						const instrument: Instrument =
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
						instrument.stringSustain = clamp(
							0,
							Config.stringSustainRange,
							base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
						);
					}
					break;
				case SongTagCode.fadeInOut:
					{
						if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							// this tag was used for a combination of transition and fade in/out.
							const legacySettings = [
								{ transition: "interrupt", fadeInSeconds: 0, fadeOutTicks: -1 },
								{ transition: "normal", fadeInSeconds: 0, fadeOutTicks: -3 },
								{ transition: "normal", fadeInSeconds: 0.025, fadeOutTicks: -3 },
								{ transition: "slide in pattern", fadeInSeconds: 0.025, fadeOutTicks: -3 },
								{ transition: "normal", fadeInSeconds: 0.04, fadeOutTicks: 6 },
								{ transition: "normal", fadeInSeconds: 0, fadeOutTicks: 48 },
								{ transition: "normal", fadeInSeconds: 0.0125, fadeOutTicks: 72 },
								{ transition: "normal", fadeInSeconds: 0.06, fadeOutTicks: 96 }
							];
							if (beforeThree && fromBeepBox) {
								const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
								const settings =
									legacySettings[
										clamp(
											0,
											legacySettings.length,
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										)
									];
								const instrument: Instrument = this.channels[channelIndex].instruments[0];
								instrument.fadeIn = Synth.secondsToFadeInSetting(settings.fadeInSeconds);
								instrument.fadeOut = Synth.ticksToFadeOutSetting(settings.fadeOutTicks);
								instrument.transition = Config.transitions.dictionary[settings.transition].index;
								if (instrument.transition != Config.transitions.dictionary["normal"].index) {
									// Enable transition if it was used.
									instrument.effects |= 1 << EffectType.transition;
								}
							} else if (beforeSix && fromBeepBox) {
								for (
									let channelIndex: number = 0;
									channelIndex < this.getChannelCount();
									channelIndex++
								) {
									for (const instrument of this.channels[channelIndex].instruments) {
										const settings =
											legacySettings[
												clamp(
													0,
													legacySettings.length,
													base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
												)
											];
										instrument.fadeIn = Synth.secondsToFadeInSetting(settings.fadeInSeconds);
										instrument.fadeOut = Synth.ticksToFadeOutSetting(settings.fadeOutTicks);
										instrument.transition =
											Config.transitions.dictionary[settings.transition].index;
										if (instrument.transition != Config.transitions.dictionary["normal"].index) {
											// Enable transition if it was used.
											instrument.effects |= 1 << EffectType.transition;
										}
									}
								}
							} else if (beforeFour || fromBeepBox) {
								const settings =
									legacySettings[
										clamp(
											0,
											legacySettings.length,
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										)
									];
								const instrument: Instrument =
									this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
								instrument.fadeIn = Synth.secondsToFadeInSetting(settings.fadeInSeconds);
								instrument.fadeOut = Synth.ticksToFadeOutSetting(settings.fadeOutTicks);
								instrument.transition = Config.transitions.dictionary[settings.transition].index;
								if (instrument.transition != Config.transitions.dictionary["normal"].index) {
									// Enable transition if it was used.
									instrument.effects |= 1 << EffectType.transition;
								}
							} else {
								const settings =
									legacySettings[
										clamp(
											0,
											legacySettings.length,
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										)
									];
								const instrument: Instrument =
									this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
								instrument.fadeIn = Synth.secondsToFadeInSetting(settings.fadeInSeconds);
								instrument.fadeOut = Synth.ticksToFadeOutSetting(settings.fadeOutTicks);
								instrument.transition = Config.transitions.dictionary[settings.transition].index;

								// Read tie-note
								if (base64CharCodeToInt[compressed.charCodeAt(charIndex++)] > 0) {
									// Set legacy tie over flag, which is only used to port notes in patterns using this instrument as tying.
									instrument.legacyTieOver = true;
								}
								instrument.clicklessTransition = base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									? true
									: false;

								if (
									instrument.transition != Config.transitions.dictionary["normal"].index ||
									instrument.clicklessTransition
								) {
									// Enable transition if it was used.
									instrument.effects |= 1 << EffectType.transition;
								}
							}
						} else {
							const instrument: Instrument =
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
							instrument.fadeIn = clamp(
								0,
								Config.fadeInRange,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
							instrument.fadeOut = clamp(
								0,
								Config.fadeOutTicks.length,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
							if (fromJummBox)
								instrument.clicklessTransition = base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									? true
									: false;
						}
					}
					break;
				case SongTagCode.vibrato:
					{
						if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							if (beforeSeven && fromBeepBox) {
								if (beforeThree && fromBeepBox) {
									const legacyEffects: number[] = [0, 3, 2, 0];
									const legacyEnvelopes: string[] = ["none", "none", "none", "tremolo2"];
									const channelIndex: number =
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
									const effect: number = clamp(
										0,
										legacyEffects.length,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
									const instrument: Instrument = this.channels[channelIndex].instruments[0];
									const legacySettings: LegacySettings = legacySettingsCache![channelIndex][0];
									instrument.vibrato = legacyEffects[effect];
									if (
										legacySettings.filterEnvelope == undefined ||
										legacySettings.filterEnvelope.type == EnvelopeType.none
									) {
										// Imitate the legacy tremolo with a filter envelope.
										legacySettings.filterEnvelope =
											Config.envelopes.dictionary[legacyEnvelopes[effect]];
										instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
									}
									if (instrument.vibrato != Config.vibratos.dictionary["none"].index) {
										// Enable vibrato if it was used.
										instrument.effects |= 1 << EffectType.vibrato;
									}
								} else if (beforeSix && fromBeepBox) {
									const legacyEffects: number[] = [0, 1, 2, 3, 0, 0];
									const legacyEnvelopes: string[] = [
										"none",
										"none",
										"none",
										"none",
										"tremolo5",
										"tremolo2"
									];
									for (
										let channelIndex: number = 0;
										channelIndex < this.getChannelCount();
										channelIndex++
									) {
										for (
											let i: number = 0;
											i < this.channels[channelIndex].instruments.length;
											i++
										) {
											const effect: number = clamp(
												0,
												legacyEffects.length,
												base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
											);
											const instrument: Instrument = this.channels[channelIndex].instruments[i];
											const legacySettings: LegacySettings =
												legacySettingsCache![channelIndex][i];
											instrument.vibrato = legacyEffects[effect];
											if (
												legacySettings.filterEnvelope == undefined ||
												legacySettings.filterEnvelope.type == EnvelopeType.none
											) {
												// Imitate the legacy tremolo with a filter envelope.
												legacySettings.filterEnvelope =
													Config.envelopes.dictionary[legacyEnvelopes[effect]];
												instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
											}
											if (instrument.vibrato != Config.vibratos.dictionary["none"].index) {
												// Enable vibrato if it was used.
												instrument.effects |= 1 << EffectType.vibrato;
											}
											if (
												(legacyGlobalReverb != 0 || (fromJummBox && beforeFive)) &&
												!this.getChannelIsNoise(channelIndex)
											) {
												// Enable reverb if it was used globaly before. (Global reverb was added before the effects option so I need to pick somewhere else to initialize instrument reverb, and I picked the vibrato command.)
												instrument.effects |= 1 << EffectType.reverb;
												instrument.reverb = legacyGlobalReverb;
											}
										}
									}
								} else {
									const legacyEffects: number[] = [0, 1, 2, 3, 0, 0];
									const legacyEnvelopes: string[] = [
										"none",
										"none",
										"none",
										"none",
										"tremolo5",
										"tremolo2"
									];
									const effect: number = clamp(
										0,
										legacyEffects.length,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
									const instrument: Instrument =
										this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
									const legacySettings: LegacySettings =
										legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
									instrument.vibrato = legacyEffects[effect];
									if (
										legacySettings.filterEnvelope == undefined ||
										legacySettings.filterEnvelope.type == EnvelopeType.none
									) {
										// Imitate the legacy tremolo with a filter envelope.
										legacySettings.filterEnvelope =
											Config.envelopes.dictionary[legacyEnvelopes[effect]];
										instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
									}
									if (instrument.vibrato != Config.vibratos.dictionary["none"].index) {
										// Enable vibrato if it was used.
										instrument.effects |= 1 << EffectType.vibrato;
									}
									if (legacyGlobalReverb != 0 || (fromJummBox && beforeFive)) {
										// Enable reverb if it was used globaly before. (Global reverb was added before the effects option so I need to pick somewhere else to initialize instrument reverb, and I picked the vibrato command.)
										instrument.effects |= 1 << EffectType.reverb;
										instrument.reverb = legacyGlobalReverb;
									}
								}
							} else {
								const instrument: Instrument =
									this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
								const vibrato: number = clamp(
									0,
									Config.vibratos.length + 1,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
								instrument.vibrato = vibrato;
								if (instrument.vibrato != Config.vibratos.dictionary["none"].index) {
									// Enable vibrato if it was used.
									instrument.effects |= 1 << EffectType.vibrato;
								}
								// Custom vibrato
								if (vibrato == Config.vibratos.length) {
									instrument.vibratoDepth =
										clamp(
											0,
											Config.modulators.dictionary["vibrato depth"].maxRawVol + 1,
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										) / 50;
									instrument.vibratoSpeed = clamp(
										0,
										Config.modulators.dictionary["vibrato speed"].maxRawVol + 1,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
									instrument.vibratoDelay =
										clamp(
											0,
											Config.modulators.dictionary["vibrato delay"].maxRawVol + 1,
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										) / 2;
									instrument.vibratoType = clamp(
										0,
										Config.vibratoTypes.length,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
									instrument.effects |= 1 << EffectType.vibrato;
								}

								// Enforce standard vibrato settings
								else {
									instrument.vibratoDepth = Config.vibratos[instrument.vibrato].amplitude;
									instrument.vibratoSpeed = 10; // Normal speed
									instrument.vibratoDelay = Config.vibratos[instrument.vibrato].delayTicks / 2;
									instrument.vibratoType = Config.vibratos[instrument.vibrato].type;
								}
							}
						} else {
							// Do nothing? This song tag code is deprecated for now.
						}
					}
					break;
				case SongTagCode.arpeggioSpeed:
					{
						// Deprecated, but supported for legacy purposes
						if (fromJummBox && beforeFive) {
							const instrument: Instrument =
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
							instrument.arpeggioSpeed = clamp(
								0,
								Config.modulators.dictionary["arp speed"].maxRawVol + 1,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
							instrument.fastTwoNoteArp = base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								? true
								: false; // Two note arp setting piggybacks on this
						} else {
							// Do nothing, deprecated for now
						}
					}
					break;
				case SongTagCode.unison:
					{
						if (beforeThree && fromBeepBox) {
							const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							this.channels[channelIndex].instruments[0].unison = clamp(
								0,
								Config.unisons.length,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
						} else if (beforeSix && fromBeepBox) {
							for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
								for (const instrument of this.channels[channelIndex].instruments) {
									const originalValue: number =
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
									let unison: number = clamp(0, Config.unisons.length, originalValue);
									if (originalValue == 8) {
										// original "custom harmony" now maps to "hum" and "custom interval".
										unison = 2;
										instrument.chord = 3;
									}
									instrument.unison = unison;
								}
							}
						} else if (beforeSeven && fromBeepBox) {
							const originalValue: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							let unison: number = clamp(0, Config.unisons.length, originalValue);
							if (originalValue == 8) {
								// original "custom harmony" now maps to "hum" and "custom interval".
								unison = 2;
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].chord = 3;
							}
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].unison =
								unison;
						} else {
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].unison =
								clamp(
									0,
									Config.unisons.length,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
						}
					}
					break;
				case SongTagCode.chord:
					{
						if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							const instrument: Instrument =
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
							instrument.chord = clamp(
								0,
								Config.chords.length,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
							if (instrument.chord != Config.chords.dictionary["simultaneous"].index) {
								// Enable chord if it was used.
								instrument.effects |= 1 << EffectType.chord;
							}
						} else {
							// Do nothing? This song tag code is deprecated for now.
						}
					}
					break;
				case SongTagCode.effects:
					{
						const instrument: Instrument =
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
						if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							instrument.effects =
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)] &
								((1 << EffectType.length) - 1);
							if (legacyGlobalReverb == 0 && !(fromJummBox && beforeFive)) {
								// Disable reverb if legacy song reverb was zero.
								instrument.effects &= ~(1 << EffectType.reverb);
							} else if (effectsIncludeReverb(instrument.effects)) {
								instrument.reverb = legacyGlobalReverb;
							}
							// @jummbus - Enabling pan effect on song import no matter what to make it a default.
							//if (instrument.pan != Config.panCenter) {
							instrument.effects |= 1 << EffectType.panning;
							//}
							if (instrument.vibrato != Config.vibratos.dictionary["none"].index) {
								// Enable vibrato if it was used.
								instrument.effects |= 1 << EffectType.vibrato;
							}
							if (instrument.detune != Config.detuneCenter) {
								// Enable detune if it was used.
								instrument.effects |= 1 << EffectType.detune;
							}
							if (instrument.aliases) instrument.effects |= 1 << EffectType.distortion;
							else instrument.effects &= ~(1 << EffectType.distortion);

							// convertLegacySettings may need to force-enable note filter, call
							// it again here to make sure that this override takes precedence.
							const legacySettings: LegacySettings =
								legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
							instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
						} else {
							// BeepBox currently uses two base64 characters at 6 bits each for a bitfield representing all the enabled effects.
							if (EffectType.length > 12) throw new Error();
							instrument.effects =
								(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) |
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)];

							if (effectsIncludeNoteFilter(instrument.effects)) {
								let typeCheck: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
								if (fromBeepBox || typeCheck == 0) {
									instrument.noteFilterType = false;
									if (fromJummBox)
										typeCheck = base64CharCodeToInt[compressed.charCodeAt(charIndex++)]; // Skip to next index in jummbox to get actual count
									instrument.noteFilter.controlPointCount = clamp(
										0,
										Config.filterMaxPoints + 1,
										typeCheck
									);
									for (
										let i: number = instrument.noteFilter.controlPoints.length;
										i < instrument.noteFilter.controlPointCount;
										i++
									) {
										instrument.noteFilter.controlPoints[i] = new FilterControlPoint();
									}
									for (let i: number = 0; i < instrument.noteFilter.controlPointCount; i++) {
										const point: FilterControlPoint = instrument.noteFilter.controlPoints[i];
										point.type = clamp(
											0,
											FilterType.length,
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										);
										point.freq = clamp(
											0,
											Config.filterFreqRange,
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										);
										point.gain = clamp(
											0,
											Config.filterGainRange,
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										);
									}
									for (let i: number = instrument.noteFilter.controlPointCount; i < typeCheck; i++) {
										charIndex += 3;
									}

									// Get subfilters as well. Skip Index 0, is a copy of the base filter.
									instrument.noteSubFilters[0] = instrument.noteFilter;
									if (fromJummBox && !beforeFive) {
										let usingSubFilterBitfield: number =
											(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) |
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
										for (let j: number = 0; j < Config.filterMorphCount - 1; j++) {
											if (usingSubFilterBitfield & (1 << j)) {
												// Number of control points
												const originalSubfilterControlPointCount: number =
													base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
												if (instrument.noteSubFilters[j + 1] == null)
													instrument.noteSubFilters[j + 1] = new FilterSettings();
												instrument.noteSubFilters[j + 1]!.controlPointCount = clamp(
													0,
													Config.filterMaxPoints + 1,
													originalSubfilterControlPointCount
												);
												for (
													let i: number =
														instrument.noteSubFilters[j + 1]!.controlPoints.length;
													i < instrument.noteSubFilters[j + 1]!.controlPointCount;
													i++
												) {
													instrument.noteSubFilters[j + 1]!.controlPoints[i] =
														new FilterControlPoint();
												}
												for (
													let i: number = 0;
													i < instrument.noteSubFilters[j + 1]!.controlPointCount;
													i++
												) {
													const point: FilterControlPoint =
														instrument.noteSubFilters[j + 1]!.controlPoints[i];
													point.type = clamp(
														0,
														FilterType.length,
														base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
													);
													point.freq = clamp(
														0,
														Config.filterFreqRange,
														base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
													);
													point.gain = clamp(
														0,
														Config.filterGainRange,
														base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
													);
												}
												for (
													let i: number = instrument.noteSubFilters[j + 1]!.controlPointCount;
													i < originalSubfilterControlPointCount;
													i++
												) {
													charIndex += 3;
												}
											}
										}
									}
								} else {
									instrument.noteFilterType = true;
									instrument.noteFilter.reset();
									instrument.noteFilterSimpleCut = clamp(
										0,
										Config.filterSimpleCutRange,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
									instrument.noteFilterSimplePeak = clamp(
										0,
										Config.filterSimplePeakRange,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
								}
							}
							if (effectsIncludeTransition(instrument.effects)) {
								instrument.transition = clamp(
									0,
									Config.transitions.length,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
							}
							if (effectsIncludeChord(instrument.effects)) {
								instrument.chord = clamp(
									0,
									Config.chords.length,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
								// Custom arpeggio speed... only in JB, and only if the instrument arpeggiates.
								if (instrument.chord == Config.chords.dictionary["arpeggio"].index && fromJummBox) {
									instrument.arpeggioSpeed = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
									instrument.fastTwoNoteArp = base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										? true
										: false;
								}
							}
							if (effectsIncludePitchShift(instrument.effects)) {
								instrument.pitchShift = clamp(
									0,
									Config.pitchShiftRange,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
							}
							if (effectsIncludeDetune(instrument.effects)) {
								if (fromBeepBox) {
									// Convert from BeepBox's formula
									instrument.detune = clamp(
										Config.detuneMin,
										Config.detuneMax + 1,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
									instrument.detune = Math.round(
										((instrument.detune - 9) * (Math.abs(instrument.detune - 9) + 1)) / 2 +
											Config.detuneCenter
									);
								} else {
									instrument.detune = clamp(
										Config.detuneMin,
										Config.detuneMax + 1,
										(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) +
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
								}
							}
							if (effectsIncludeVibrato(instrument.effects)) {
								instrument.vibrato = clamp(
									0,
									Config.vibratos.length + 1,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);

								// Custom vibrato
								if (instrument.vibrato == Config.vibratos.length && fromJummBox) {
									instrument.vibratoDepth =
										clamp(
											0,
											Config.modulators.dictionary["vibrato depth"].maxRawVol + 1,
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										) / 25;
									instrument.vibratoSpeed = clamp(
										0,
										Config.modulators.dictionary["vibrato speed"].maxRawVol + 1,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
									instrument.vibratoDelay = clamp(
										0,
										Config.modulators.dictionary["vibrato delay"].maxRawVol + 1,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
									instrument.vibratoType = clamp(
										0,
										Config.vibratoTypes.length,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
								}

								// Enforce standard vibrato settings
								else {
									instrument.vibratoDepth = Config.vibratos[instrument.vibrato].amplitude;
									instrument.vibratoSpeed = 10; // Normal speed
									instrument.vibratoDelay = Config.vibratos[instrument.vibrato].delayTicks / 2;
									instrument.vibratoType = Config.vibratos[instrument.vibrato].type;
								}
							}
							if (effectsIncludeDistortion(instrument.effects)) {
								instrument.distortion = clamp(
									0,
									Config.distortionRange,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
								if (fromJummBox && !beforeFive)
									instrument.aliases = base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										? true
										: false;
							}
							if (effectsIncludeBitcrusher(instrument.effects)) {
								instrument.bitcrusherFreq = clamp(
									0,
									Config.bitcrusherFreqRange,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
								instrument.bitcrusherQuantization = clamp(
									0,
									Config.bitcrusherQuantizationRange,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
							}
							if (effectsIncludePanning(instrument.effects)) {
								if (fromBeepBox) {
									// Beepbox has a panMax of 8 (9 total positions), Jummbox has a panMax of 100 (101 total positions)
									instrument.pan = clamp(
										0,
										Config.panMax + 1,
										Math.round(
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)] *
												(Config.panMax / 8)
										)
									);
								} else {
									instrument.pan = clamp(
										0,
										Config.panMax + 1,
										(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) +
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
								}

								// Now, pan delay follows on new versions of jummbox.
								if (fromJummBox && !beforeTwo)
									instrument.panDelay = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							}
							if (effectsIncludeChorus(instrument.effects)) {
								if (fromBeepBox) {
									// BeepBox has 4 chorus values vs. JB's 8
									instrument.chorus =
										clamp(
											0,
											Config.chorusRange / 2 + 1,
											base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
										) * 2;
								} else {
									instrument.chorus = clamp(
										0,
										Config.chorusRange,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
								}
							}
							if (effectsIncludeEcho(instrument.effects)) {
								instrument.echoSustain = clamp(
									0,
									Config.echoSustainRange,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
								instrument.echoDelay = clamp(
									0,
									Config.echoDelayRange,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
							}
							if (effectsIncludeReverb(instrument.effects)) {
								if (fromBeepBox) {
									instrument.reverb = clamp(
										0,
										Config.reverbRange,
										Math.round(
											(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] *
												Config.reverbRange) /
												3
										)
									);
								} else {
									instrument.reverb = clamp(
										0,
										Config.reverbRange,
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
									);
								}
							}
						}
						// Clamp the range.
						instrument.effects &= (1 << EffectType.length) - 1;
					}
					break;
				case SongTagCode.volume:
					{
						if (beforeThree && fromBeepBox) {
							const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							const instrument: Instrument = this.channels[channelIndex].instruments[0];
							instrument.volume = Math.round(
								clamp(
									-Config.volumeRange / 2,
									1,
									-base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 5
								)
							);
						} else if (beforeSix && fromBeepBox) {
							for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
								for (const instrument of this.channels[channelIndex].instruments) {
									instrument.volume = Math.round(
										clamp(
											-Config.volumeRange / 2,
											1,
											-base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 5
										)
									);
								}
							}
						} else if (beforeSeven && fromBeepBox) {
							const instrument: Instrument =
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
							instrument.volume = Math.round(
								clamp(
									-Config.volumeRange / 2,
									1,
									-base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 5
								)
							);
						} else if (fromBeepBox) {
							// Beepbox v9's volume range is 0-7 (0 is max, 7 is mute)
							const instrument: Instrument =
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
							instrument.volume = Math.round(
								clamp(
									-Config.volumeRange / 2,
									1,
									(-base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 25) / 7
								)
							);
						} else {
							const instrument: Instrument =
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
							// Volume is stored in two bytes in jummbox just in case range ever exceeds one byte, e.g. through later waffling on the subject.
							instrument.volume = Math.round(
								clamp(
									-Config.volumeRange / 2,
									Config.volumeRange / 2 + 1,
									((base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) |
										base64CharCodeToInt[compressed.charCodeAt(charIndex++)]) -
										Config.volumeRange / 2
								)
							);
						}
					}
					break;
				case SongTagCode.pan:
					{
						if (beforeNine && fromBeepBox) {
							// Beepbox has a panMax of 8 (9 total positions), Jummbox has a panMax of 100 (101 total positions)
							const instrument: Instrument =
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
							instrument.pan = clamp(
								0,
								Config.panMax + 1,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * (Config.panMax / 8)
							);
						} else if (beforeFive && fromJummBox) {
							const instrument: Instrument =
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
							instrument.pan = clamp(
								0,
								Config.panMax + 1,
								(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) +
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
							// Pan delay follows on v3 + v4
							if (fromJummBox && !beforeThree) {
								instrument.panDelay = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							}
						} else {
							// Do nothing? This song tag code is deprecated for now.
						}
					}
					break;
				case SongTagCode.detune:
					{
						const instrument: Instrument =
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];

						if (fromJummBox && beforeFive) {
							// Before jummbox v5, detune was -50 to 50. Now it is 0 to 400
							instrument.detune = clamp(
								Config.detuneMin,
								Config.detuneMax + 1,
								((base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) +
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]) *
									4
							);
							instrument.effects |= 1 << EffectType.detune;
						} else {
							// Now in v5, tag code is deprecated and handled thru detune effects.
						}
					}
					break;
				case SongTagCode.customChipWave:
					{
						let instrument: Instrument =
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
						// Pop custom wave values
						for (let j: number = 0; j < 64; j++) {
							instrument.customChipWave[j] = clamp(
								-24,
								25,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)] - 24
							);
						}

						let sum: number = 0;
						for (let i: number = 0; i < instrument.customChipWave.length; i++) {
							sum += instrument.customChipWave[i];
						}
						const average: number = sum / instrument.customChipWave.length;

						// Perform the integral on the wave. The chipSynth will perform the derivative to get the original wave back but with antialiasing.
						let cumulative: number = 0;
						let wavePrev: number = 0;
						for (let i: number = 0; i < instrument.customChipWave.length; i++) {
							cumulative += wavePrev;
							wavePrev = instrument.customChipWave[i] - average;
							instrument.customChipWaveIntegral[i] = cumulative;
						}

						// 65th, last sample is for anti-aliasing
						instrument.customChipWaveIntegral[64] = 0;
					}
					break;
				case SongTagCode.limiterSettings:
					{
						let nextValue: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];

						// Check if limiter settings are used... if not, restore to default
						if (nextValue == 63) {
							this.restoreLimiterDefaults();
						} else {
							// Limiter is used, grab values
							this.compressionRatio = nextValue < 10 ? nextValue / 10 : 1 + (nextValue - 10) / 60;
							nextValue = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							this.limitRatio = nextValue < 10 ? nextValue / 10 : nextValue - 9;
							this.limitDecay = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							this.limitRise = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] * 250 + 2000;
							this.compressionThreshold = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] / 20;
							this.limitThreshold = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] / 20;
							this.masterGain =
								((base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) +
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]) /
								50;
						}
					}
					break;
				case SongTagCode.channelNames:
					{
						for (let channel: number = 0; channel < this.getChannelCount(); channel++) {
							// Length of channel name string. Due to some crazy Unicode characters this needs to be 2 bytes...
							var channelNameLength;
							if (beforeFour) channelNameLength = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							else
								channelNameLength =
									(base64CharCodeToInt[compressed.charCodeAt(charIndex++)] << 6) +
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							this.channels[channel].name = decodeURIComponent(
								compressed.substring(charIndex, charIndex + channelNameLength)
							);

							charIndex += channelNameLength;
						}
					}
					break;
				case SongTagCode.algorithm:
					{
						const instrument: Instrument =
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
						instrument.algorithm = clamp(
							0,
							Config.algorithms.length,
							base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
						);
						if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							// The algorithm determines the carrier count, which affects how legacy settings are imported.
							const legacySettings: LegacySettings =
								legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
							instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
						}
					}
					break;
				case SongTagCode.feedbackType:
					{
						this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].feedbackType =
							clamp(0, Config.feedbacks.length, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
					}
					break;
				case SongTagCode.feedbackAmplitude:
					{
						this.channels[instrumentChannelIterator].instruments[
							instrumentIndexIterator
						].feedbackAmplitude = clamp(
							0,
							Config.operatorAmplitudeMax + 1,
							base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
						);
					}
					break;
				case SongTagCode.feedbackEnvelope:
					{
						if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							const instrument: Instrument =
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
							const legacySettings: LegacySettings =
								legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
							legacySettings.feedbackEnvelope = Song._envelopeFromLegacyIndex(
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
							instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
						} else {
							// Do nothing? This song tag code is deprecated for now.
						}
					}
					break;
				case SongTagCode.operatorFrequencies:
					{
						for (let o: number = 0; o < Config.operatorCount; o++) {
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].operators[
								o
							].frequency = clamp(
								0,
								Config.operatorFrequencies.length,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
						}
					}
					break;
				case SongTagCode.operatorAmplitudes:
					{
						for (let o: number = 0; o < Config.operatorCount; o++) {
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator].operators[
								o
							].amplitude = clamp(
								0,
								Config.operatorAmplitudeMax + 1,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
						}
					}
					break;
				case SongTagCode.envelopes:
					{
						const instrument: Instrument =
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
						if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
							const legacySettings: LegacySettings =
								legacySettingsCache![instrumentChannelIterator][instrumentIndexIterator];
							legacySettings.operatorEnvelopes = [];
							for (let o: number = 0; o < Config.operatorCount; o++) {
								legacySettings.operatorEnvelopes[o] = Song._envelopeFromLegacyIndex(
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
							}
							instrument.convertLegacySettings(legacySettings, forceSimpleFilter);
						} else {
							const envelopeCount: number = clamp(
								0,
								Config.maxEnvelopeCount + 1,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
							for (let i: number = 0; i < envelopeCount; i++) {
								const target: number = clamp(
									0,
									Config.instrumentAutomationTargets.length,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
								let index: number = 0;
								const maxCount: number = Config.instrumentAutomationTargets[target].maxCount;
								if (maxCount > 1) {
									index = clamp(0, maxCount, base64CharCodeToInt[compressed.charCodeAt(charIndex++)]);
								}
								const envelope: number = clamp(
									0,
									Config.envelopes.length,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
								instrument.addEnvelope(target, index, envelope);
							}
						}
					}
					break;
				case SongTagCode.operatorWaves:
					{
						const instrument: Instrument =
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
						for (let o: number = 0; o < Config.operatorCount; o++) {
							instrument.operators[o].waveform = clamp(
								0,
								Config.operatorWaves.length,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
							// Pulse width follows, if it is a pulse width operator wave
							if (instrument.operators[o].waveform == 3) {
								instrument.operators[o].pulseWidth = clamp(
									0,
									Config.pwmOperatorWaves.length,
									base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
								);
							}
						}
					}
					break;
				case SongTagCode.spectrum:
					{
						const instrument: Instrument =
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
						if (instrument.type == InstrumentType.spectrum) {
							const byteCount: number = Math.ceil(
								(Config.spectrumControlPoints * Config.spectrumControlPointBits) / 6
							);
							const bits: BitFieldReader = new BitFieldReader(
								compressed,
								charIndex,
								charIndex + byteCount
							);
							for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
								instrument.spectrumWave.spectrum[i] = bits.read(Config.spectrumControlPointBits);
							}
							instrument.spectrumWave.markCustomWaveDirty();
							charIndex += byteCount;
						} else if (instrument.type == InstrumentType.drumset) {
							const byteCount: number = Math.ceil(
								(Config.drumCount * Config.spectrumControlPoints * Config.spectrumControlPointBits) / 6
							);
							const bits: BitFieldReader = new BitFieldReader(
								compressed,
								charIndex,
								charIndex + byteCount
							);
							for (let j: number = 0; j < Config.drumCount; j++) {
								for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
									instrument.drumsetSpectrumWaves[j].spectrum[i] = bits.read(
										Config.spectrumControlPointBits
									);
								}
								instrument.drumsetSpectrumWaves[j].markCustomWaveDirty();
							}
							charIndex += byteCount;
						} else {
							throw new Error("Unhandled instrument type for spectrum song tag code.");
						}
					}
					break;
				case SongTagCode.harmonics:
					{
						const instrument: Instrument =
							this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
						const byteCount: number = Math.ceil(
							(Config.harmonicsControlPoints * Config.harmonicsControlPointBits) / 6
						);
						const bits: BitFieldReader = new BitFieldReader(compressed, charIndex, charIndex + byteCount);
						for (let i: number = 0; i < Config.harmonicsControlPoints; i++) {
							instrument.harmonicsWave.harmonics[i] = bits.read(Config.harmonicsControlPointBits);
						}
						instrument.harmonicsWave.markCustomWaveDirty();
						charIndex += byteCount;
					}
					break;
				case SongTagCode.aliases:
					{
						if (fromJummBox && beforeFive) {
							const instrument: Instrument =
								this.channels[instrumentChannelIterator].instruments[instrumentIndexIterator];
							instrument.aliases = base64CharCodeToInt[compressed.charCodeAt(charIndex++)] ? true : false;
							if (instrument.aliases) {
								instrument.distortion = 0;
								instrument.effects |= 1 << EffectType.distortion;
							}
						} else {
							// Do nothing, deprecated
						}
					}
					break;
				case SongTagCode.bars:
					{
						let subStringLength: number;
						if (beforeThree && fromBeepBox) {
							const channelIndex: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							const barCount: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							subStringLength = Math.ceil(barCount * 0.5);
							const bits: BitFieldReader = new BitFieldReader(
								compressed,
								charIndex,
								charIndex + subStringLength
							);
							for (let i: number = 0; i < barCount; i++) {
								this.channels[channelIndex].bars[i] = bits.read(3) + 1;
							}
						} else if (beforeFive && fromBeepBox) {
							let neededBits: number = 0;
							while (1 << neededBits < this.patternsPerChannel) neededBits++;
							subStringLength = Math.ceil((this.getChannelCount() * this.barCount * neededBits) / 6);
							const bits: BitFieldReader = new BitFieldReader(
								compressed,
								charIndex,
								charIndex + subStringLength
							);
							for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
								for (let i: number = 0; i < this.barCount; i++) {
									this.channels[channelIndex].bars[i] = bits.read(neededBits) + 1;
								}
							}
						} else {
							let neededBits: number = 0;
							while (1 << neededBits < this.patternsPerChannel + 1) neededBits++;
							subStringLength = Math.ceil((this.getChannelCount() * this.barCount * neededBits) / 6);
							const bits: BitFieldReader = new BitFieldReader(
								compressed,
								charIndex,
								charIndex + subStringLength
							);
							for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
								for (let i: number = 0; i < this.barCount; i++) {
									this.channels[channelIndex].bars[i] = bits.read(neededBits);
								}
							}
						}
						charIndex += subStringLength;
					}
					break;
				case SongTagCode.patterns:
					{
						let bitStringLength: number = 0;
						let channelIndex: number;
						let largerChords: boolean = !((beforeFour && fromJummBox) || fromBeepBox);
						let recentPitchBitLength: number = largerChords ? 4 : 3;
						let recentPitchLength: number = largerChords ? 16 : 8;
						if (beforeThree && fromBeepBox) {
							channelIndex = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];

							// The old format used the next character to represent the number of patterns in the channel, which is usually eight, the default.
							charIndex++; //let patternCount: number = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];

							bitStringLength = base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
							bitStringLength = bitStringLength << 6;
							bitStringLength += base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
						} else {
							channelIndex = 0;
							let bitStringLengthLength: number = validateRange(
								1,
								4,
								base64CharCodeToInt[compressed.charCodeAt(charIndex++)]
							);
							while (bitStringLengthLength > 0) {
								bitStringLength = bitStringLength << 6;
								bitStringLength += base64CharCodeToInt[compressed.charCodeAt(charIndex++)];
								bitStringLengthLength--;
							}
						}

						const bits: BitFieldReader = new BitFieldReader(
							compressed,
							charIndex,
							charIndex + bitStringLength
						);
						charIndex += bitStringLength;

						const bitsPerNoteSize: number = Song.getNeededBits(Config.noteSizeMax);
						let songReverbChannel: number = -1;
						let songReverbInstrument: number = -1;
						let songReverbIndex: number = -1;

						while (true) {
							const channel: Channel = this.channels[channelIndex];
							const isNoiseChannel: boolean = this.getChannelIsNoise(channelIndex);
							const isModChannel: boolean = this.getChannelIsMod(channelIndex);

							const maxInstrumentsPerPattern: number = this.getMaxInstrumentsPerPattern(channelIndex);
							const neededInstrumentCountBits: number = Song.getNeededBits(
								maxInstrumentsPerPattern - Config.instrumentCountMin
							);

							const neededInstrumentIndexBits: number = Song.getNeededBits(
								channel.instruments.length - 1
							);

							// Some info about modulator settings immediately follows in mod channels.
							if (isModChannel) {
								// 2 more indices for 'all' and 'active'
								const neededModInstrumentIndexBits: number = beforeFive
									? neededInstrumentIndexBits
									: Song.getNeededBits(this.getMaxInstrumentsPerChannel() + 2);

								for (
									let instrumentIndex: number = 0;
									instrumentIndex < channel.instruments.length;
									instrumentIndex++
								) {
									let instrument: Instrument = channel.instruments[instrumentIndex];

									for (let mod: number = 0; mod < Config.modCount; mod++) {
										// Still using legacy "mod status" format, but doing it manually as it's only used in the URL now.
										// 0 - For pitch/noise
										// 1 - (used to be For noise, not needed)
										// 2 - For song
										// 3 - None
										let status: number = bits.read(2);

										switch (status) {
											case 0: // Pitch
												instrument.modChannels[mod] = clamp(
													0,
													this.pitchChannelCount + this.noiseChannelCount + 1,
													bits.read(8)
												);
												instrument.modInstruments[mod] = clamp(
													0,
													this.channels[instrument.modChannels[mod]].instruments.length + 2,
													bits.read(neededModInstrumentIndexBits)
												);
												break;
											case 1: // Noise
												// Getting a status of 1 means this is legacy mod info. Need to add pitch channel count, as it used to just store noise channel index and not overall channel index
												instrument.modChannels[mod] =
													this.pitchChannelCount +
													clamp(0, this.noiseChannelCount + 1, bits.read(8));
												instrument.modInstruments[mod] = clamp(
													0,
													this.channels[instrument.modChannels[mod]].instruments.length + 2,
													bits.read(neededInstrumentIndexBits)
												);
												break;
											case 2: // For song
												instrument.modChannels[mod] = -1;
												break;
											case 3: // None
												instrument.modChannels[mod] = -2;
												break;
										}

										// Mod setting is only used if the status isn't "none".
										if (status != 3) {
											instrument.modulators[mod] = bits.read(6);
										}

										if (
											!beforeFive &&
											(Config.modulators[instrument.modulators[mod]].name == "eq filter" ||
												Config.modulators[instrument.modulators[mod]].name == "note filter")
										) {
											instrument.modFilterTypes[mod] = bits.read(6);
										}

										if (beforeFive && instrument.modChannels[mod] >= 0) {
											let forNoteFilter: boolean = effectsIncludeNoteFilter(
												this.channels[instrument.modChannels[mod]].instruments[
													instrument.modInstruments[mod]
												].effects
											);

											// For legacy filter cut/peak, need to denote since scaling must be applied
											if (instrument.modulators[mod] == 7) {
												// Legacy filter cut index
												// Check if there is no filter dot on prospective filter. If so, add a low pass at max possible freq.
												if (forNoteFilter) {
													instrument.modulators[mod] =
														Config.modulators.dictionary["note filt cut"].index;
												} else {
													instrument.modulators[mod] =
														Config.modulators.dictionary["eq filt cut"].index;
												}

												instrument.modFilterTypes[mod] = 1; // Dot 1 X
											} else if (instrument.modulators[mod] == 8) {
												// Legacy filter peak index
												if (forNoteFilter) {
													instrument.modulators[mod] =
														Config.modulators.dictionary["note filt peak"].index;
												} else {
													instrument.modulators[mod] =
														Config.modulators.dictionary["eq filt peak"].index;
												}

												instrument.modFilterTypes[mod] = 2; // Dot 1 Y
											}
										} else if (beforeFive) {
											// Check for song reverb mod, which must be handled differently now that it is a multiplier
											if (
												instrument.modulators[mod] ==
												Config.modulators.dictionary["song reverb"].index
											) {
												songReverbChannel = channelIndex;
												songReverbInstrument = instrumentIndex;
												songReverbIndex = mod;
											}
										}

										// Based on setting, enable some effects for the modulated instrument. This isn't always set, say if the instrument's pan was right in the center.
										// Only used on import of old songs, because sometimes an invalid effect can be set in a mod in the new version that is actually unused. In that case,
										// keeping the mod invalid is better since it preserves the state.
										if (
											beforeFive &&
											Config.modulators[instrument.modulators[mod]].associatedEffect !=
												EffectType.length
										) {
											this.channels[instrument.modChannels[mod]].instruments[
												instrument.modInstruments[mod]
											].effects |=
												1 << Config.modulators[instrument.modulators[mod]].associatedEffect;
										}
									}
								}
							}

							// Scalar applied to detune mods since its granularity was upped. Could be repurposed later if any other granularity changes occur.
							const detuneScaleNotes: number[][] = [];
							for (let j: number = 0; j < channel.instruments.length; j++) {
								detuneScaleNotes[j] = [];
								for (let i: number = 0; i < Config.modCount; i++) {
									detuneScaleNotes[j][Config.modCount - 1 - i] =
										1 +
										3 *
											+(
												beforeFive &&
												fromJummBox &&
												isModChannel &&
												channel.instruments[j].modulators[i] ==
													Config.modulators.dictionary["detune"].index
											);
								}
							}
							const octaveOffset: number = isNoiseChannel || isModChannel ? 0 : channel.octave * 12;
							let lastPitch: number = isNoiseChannel || isModChannel ? 4 : octaveOffset;
							const recentPitches: number[] = isModChannel
								? [0, 1, 2, 3, 4, 5]
								: isNoiseChannel
								? [4, 6, 7, 2, 3, 8, 0, 10]
								: [0, 7, 12, 19, 24, -5, -12];
							const recentShapes: any[] = [];
							for (let i: number = 0; i < recentPitches.length; i++) {
								recentPitches[i] += octaveOffset;
							}
							for (let i: number = 0; i < this.patternsPerChannel; i++) {
								const newPattern: Pattern = channel.patterns[i];

								if ((beforeNine && fromBeepBox) || (beforeFive && fromJummBox)) {
									newPattern.instruments[0] = validateRange(
										0,
										channel.instruments.length - 1,
										bits.read(neededInstrumentIndexBits)
									);
									newPattern.instruments.length = 1;
								} else {
									if (this.patternInstruments) {
										const instrumentCount: number = validateRange(
											Config.instrumentCountMin,
											maxInstrumentsPerPattern,
											bits.read(neededInstrumentCountBits) + Config.instrumentCountMin
										);
										for (let j: number = 0; j < instrumentCount; j++) {
											newPattern.instruments[j] = validateRange(
												0,
												channel.instruments.length - 1 + +isModChannel * 2,
												bits.read(neededInstrumentIndexBits)
											);
										}
										newPattern.instruments.length = instrumentCount;
									} else {
										newPattern.instruments[0] = 0;
										newPattern.instruments.length = Config.instrumentCountMin;
									}
								}

								if (!(fromBeepBox && beforeThree) && bits.read(1) == 0) {
									newPattern.notes.length = 0;
									continue;
								}

								let curPart: number = 0;
								const newNotes: Note[] = newPattern.notes;
								let noteCount: number = 0;
								// Due to arbitrary note positioning, mod channels don't end the count until curPart actually exceeds the max
								while (curPart < this.beatsPerBar * Config.partsPerBeat + +isModChannel) {
									const useOldShape: boolean = bits.read(1) == 1;
									let newNote: boolean = false;
									let shapeIndex: number = 0;
									if (useOldShape) {
										shapeIndex = validateRange(0, recentShapes.length - 1, bits.readLongTail(0, 0));
									} else {
										newNote = bits.read(1) == 1;
									}

									if (!useOldShape && !newNote) {
										// For mod channels, check if you need to move backward too (notes can appear in any order and offset from each other).
										if (isModChannel) {
											const isBackwards: boolean = bits.read(1) == 1;
											const restLength: number = bits.readPartDuration();
											if (isBackwards) {
												curPart -= restLength;
											} else {
												curPart += restLength;
											}
										} else {
											const restLength: number =
												beforeSeven && fromBeepBox
													? (bits.readLegacyPartDuration() * Config.partsPerBeat) /
													  Config.rhythms[this.rhythm].stepsPerBeat
													: bits.readPartDuration();
											curPart += restLength;
										}
									} else {
										let shape: any;
										if (useOldShape) {
											shape = recentShapes[shapeIndex];
											recentShapes.splice(shapeIndex, 1);
										} else {
											shape = {};

											if (!largerChords) {
												// Old format: X 1's followed by a 0 => X+1 pitches, up to 4
												shape.pitchCount = 1;
												while (shape.pitchCount < 4 && bits.read(1) == 1) shape.pitchCount++;
											} else {
												// New format is:
												//      0: 1 pitch
												// 1[XXX]: 3 bits of binary signifying 2+ pitches
												if (bits.read(1) == 1) {
													shape.pitchCount = bits.read(3) + 2;
												} else {
													shape.pitchCount = 1;
												}
											}

											shape.pinCount = bits.readPinCount();
											if (fromBeepBox) {
												shape.initialSize = bits.read(2) * 2;
											} else if (!isModChannel) {
												shape.initialSize = bits.read(bitsPerNoteSize);
											} else {
												shape.initialSize = bits.read(9);
											}

											shape.pins = [];
											shape.length = 0;
											shape.bendCount = 0;
											for (let j: number = 0; j < shape.pinCount; j++) {
												let pinObj: any = {};
												pinObj.pitchBend = bits.read(1) == 1;
												if (pinObj.pitchBend) shape.bendCount++;
												shape.length +=
													beforeSeven && fromBeepBox
														? (bits.readLegacyPartDuration() * Config.partsPerBeat) /
														  Config.rhythms[this.rhythm].stepsPerBeat
														: bits.readPartDuration();
												pinObj.time = shape.length;
												if (fromBeepBox) {
													pinObj.size = bits.read(2) * 2;
												} else if (!isModChannel) {
													pinObj.size = bits.read(bitsPerNoteSize);
												} else {
													pinObj.size = bits.read(9);
												}
												shape.pins.push(pinObj);
											}
										}
										recentShapes.unshift(shape);
										if (recentShapes.length > 10) recentShapes.pop(); // TODO: Use Deque?

										let note: Note;
										if (newNotes.length <= noteCount) {
											note = new Note(0, curPart, curPart + shape.length, shape.initialSize);
											newNotes[noteCount++] = note;
										} else {
											note = newNotes[noteCount++];
											note.start = curPart;
											note.end = curPart + shape.length;
											note.pins[0].size = shape.initialSize;
										}

										let pitch: number;
										let pitchCount: number = 0;
										const pitchBends: number[] = []; // TODO: allocate this array only once! keep separate length and iterator index. Use Deque?
										for (let j: number = 0; j < shape.pitchCount + shape.bendCount; j++) {
											const useOldPitch: boolean = bits.read(1) == 1;
											if (!useOldPitch) {
												const interval: number = bits.readPitchInterval();
												pitch = lastPitch;
												let intervalIter: number = interval;
												while (intervalIter > 0) {
													pitch++;
													while (recentPitches.indexOf(pitch) != -1) pitch++;
													intervalIter--;
												}
												while (intervalIter < 0) {
													pitch--;
													while (recentPitches.indexOf(pitch) != -1) pitch--;
													intervalIter++;
												}
											} else {
												const pitchIndex: number = validateRange(
													0,
													recentPitches.length - 1,
													bits.read(recentPitchBitLength)
												);
												pitch = recentPitches[pitchIndex];
												recentPitches.splice(pitchIndex, 1);
											}

											recentPitches.unshift(pitch);
											if (recentPitches.length > recentPitchLength) recentPitches.pop();

											if (j < shape.pitchCount) {
												note.pitches[pitchCount++] = pitch;
											} else {
												pitchBends.push(pitch);
											}

											if (j == shape.pitchCount - 1) {
												lastPitch = note.pitches[0];
											} else {
												lastPitch = pitch;
											}
										}
										note.pitches.length = pitchCount;
										pitchBends.unshift(note.pitches[0]); // TODO: Use Deque?
										if (isModChannel) {
											note.pins[0].size *=
												detuneScaleNotes[newPattern.instruments[0]][note.pitches[0]];
										}
										let pinCount: number = 1;
										for (const pinObj of shape.pins) {
											if (pinObj.pitchBend) pitchBends.shift();

											const interval: number = pitchBends[0] - note.pitches[0];
											if (note.pins.length <= pinCount) {
												if (isModChannel) {
													note.pins[pinCount++] = makeNotePin(
														interval,
														pinObj.time,
														pinObj.size *
															detuneScaleNotes[newPattern.instruments[0]][note.pitches[0]]
													);
												} else {
													note.pins[pinCount++] = makeNotePin(
														interval,
														pinObj.time,
														pinObj.size
													);
												}
											} else {
												const pin: NotePin = note.pins[pinCount++];
												pin.interval = interval;
												pin.time = pinObj.time;
												if (isModChannel) {
													pin.size =
														pinObj.size *
														detuneScaleNotes[newPattern.instruments[0]][note.pitches[0]];
												} else {
													pin.size = pinObj.size;
												}
											}
										}
										note.pins.length = pinCount;

										if (note.start == 0) {
											if (!((beforeNine && fromBeepBox) || (beforeFive && fromJummBox))) {
												note.continuesLastPattern = bits.read(1) == 1;
											} else {
												if (beforeFour || fromBeepBox) {
													note.continuesLastPattern = false;
												} else {
													note.continuesLastPattern =
														channel.instruments[newPattern.instruments[0]].legacyTieOver;
												}
											}
										}

										curPart = validateRange(0, this.beatsPerBar * Config.partsPerBeat, note.end);
									}
								}
								newNotes.length = noteCount;
							}

							if (beforeThree && fromBeepBox) {
								break;
							} else {
								channelIndex++;
								if (channelIndex >= this.getChannelCount()) break;
							}
						} // while (true)

						// Correction for old JB songs that had song reverb mods. Change all instruments using reverb to max reverb
						if (fromJummBox && beforeFive && songReverbIndex >= 0) {
							for (let channelIndex: number = 0; channelIndex < this.channels.length; channelIndex++) {
								for (
									let instrumentIndex: number = 0;
									instrumentIndex < this.channels[channelIndex].instruments.length;
									instrumentIndex++
								) {
									const instrument: Instrument =
										this.channels[channelIndex].instruments[instrumentIndex];
									if (effectsIncludeReverb(instrument.effects)) {
										instrument.reverb = Config.reverbRange - 1;
									}
									// Set song reverb via mod to the old setting at song start.
									if (songReverbChannel == channelIndex && songReverbInstrument == instrumentIndex) {
										const patternIndex: number = this.channels[channelIndex].bars[0];
										if (patternIndex > 0) {
											// Doesn't work if 1st pattern isn't using the right ins for song reverb...
											// Add note to start of pattern
											const pattern: Pattern =
												this.channels[channelIndex].patterns[patternIndex - 1];
											let lowestPart: number = 6;
											for (const note of pattern.notes) {
												if (note.pitches[0] == Config.modCount - 1 - songReverbIndex) {
													lowestPart = Math.min(lowestPart, note.start);
												}
											}

											if (lowestPart > 0) {
												pattern.notes.push(
													new Note(
														Config.modCount - 1 - songReverbIndex,
														0,
														lowestPart,
														legacyGlobalReverb
													)
												);
											}
										} else {
											// Add pattern
											if (this.channels[channelIndex].patterns.length < Config.barCountMax) {
												const pattern: Pattern = new Pattern();
												this.channels[channelIndex].patterns.push(pattern);
												this.channels[channelIndex].bars[0] =
													this.channels[channelIndex].patterns.length;
												if (
													this.channels[channelIndex].patterns.length >
													this.patternsPerChannel
												) {
													for (let chn: number = 0; chn < this.channels.length; chn++) {
														if (
															this.channels[chn].patterns.length <=
															this.patternsPerChannel
														) {
															this.channels[chn].patterns.push(new Pattern());
														}
													}
													this.patternsPerChannel++;
												}
												pattern.instruments.length = 1;
												pattern.instruments[0] = songReverbInstrument;
												pattern.notes.length = 0;
												pattern.notes.push(
													new Note(
														Config.modCount - 1 - songReverbIndex,
														0,
														6,
														legacyGlobalReverb
													)
												);
											}
										}
									}
								}
							}
						}
					}
					break;
				default:
					{
						throw new Error(
							"Unrecognized song tag code " +
								String.fromCharCode(command) +
								" at index " +
								(charIndex - 1)
						);
					}
					break;
			}
	}

	public toJsonObject(enableIntro: boolean = true, loopCount: number = 1, enableOutro: boolean = true): Object {
		const channelArray: Object[] = [];
		for (let channelIndex: number = 0; channelIndex < this.getChannelCount(); channelIndex++) {
			const channel: Channel = this.channels[channelIndex];
			const instrumentArray: Object[] = [];
			const isNoiseChannel: boolean = this.getChannelIsNoise(channelIndex);
			const isModChannel: boolean = this.getChannelIsMod(channelIndex);
			for (const instrument of channel.instruments) {
				instrumentArray.push(instrument.toJsonObject());
			}

			const patternArray: Object[] = [];
			for (const pattern of channel.patterns) {
				patternArray.push(pattern.toJsonObject(this, channel, isModChannel));
			}

			const sequenceArray: number[] = [];
			if (enableIntro)
				for (let i: number = 0; i < this.loopStart; i++) {
					sequenceArray.push(channel.bars[i]);
				}
			for (let l: number = 0; l < loopCount; l++)
				for (let i: number = this.loopStart; i < this.loopStart + this.loopLength; i++) {
					sequenceArray.push(channel.bars[i]);
				}
			if (enableOutro)
				for (let i: number = this.loopStart + this.loopLength; i < this.barCount; i++) {
					sequenceArray.push(channel.bars[i]);
				}

			const channelObject: any = {
				"type": isModChannel ? "mod" : isNoiseChannel ? "drum" : "pitch",
				"name": channel.name,
				"instruments": instrumentArray,
				"patterns": patternArray,
				"sequence": sequenceArray
			};
			if (!isNoiseChannel) {
				// For compatibility with old versions the octave is offset by one.
				channelObject["octaveScrollBar"] = channel.octave - 1;
			}
			channelArray.push(channelObject);
		}

		return {
			"name": this.title,
			"format": Song._format,
			"version": Song._latestJummBoxVersion,
			"scale": Config.scales[this.scale].name,
			"key": Config.keys[this.key].name,
			"introBars": this.loopStart,
			"loopBars": this.loopLength,
			"beatsPerBar": this.beatsPerBar,
			"ticksPerBeat": Config.rhythms[this.rhythm].stepsPerBeat,
			"beatsPerMinute": this.tempo,
			"reverb": this.reverb,
			"masterGain": this.masterGain,
			"compressionThreshold": this.compressionThreshold,
			"limitThreshold": this.limitThreshold,
			"limitDecay": this.limitDecay,
			"limitRise": this.limitRise,
			"limitRatio": this.limitRatio,
			"compressionRatio": this.compressionRatio,
			//"outroBars": this.barCount - this.loopStart - this.loopLength; // derive this from bar arrays?
			//"patternCount": this.patternsPerChannel, // derive this from pattern arrays?
			"layeredInstruments": this.layeredInstruments,
			"patternInstruments": this.patternInstruments,
			"channels": channelArray
		};
	}

	public fromJsonObject(jsonObject: any): void {
		this.initToDefault(true);
		if (!jsonObject) return;

		//const version: number = jsonObject["version"] | 0;
		//if (version > Song._latestVersion) return; // Go ahead and try to parse something from the future I guess? JSON is pretty easy-going!
		if (jsonObject["name"] != undefined) {
			this.title = jsonObject["name"];
		}

		this.scale = 0; // default to free.
		if (jsonObject["scale"] != undefined) {
			const oldScaleNames: Dictionary<string> = {
				"romani :)": "dbl harmonic :)",
				"romani :(": "dbl harmonic :(",
				"enigma": "strange"
			};
			const scaleName: string =
				oldScaleNames[jsonObject["scale"]] != undefined
					? oldScaleNames[jsonObject["scale"]]
					: jsonObject["scale"];
			const scale: number = Config.scales.findIndex(scale => scale.name == scaleName);
			if (scale != -1) this.scale = scale;
		}

		if (jsonObject["key"] != undefined) {
			if (typeof jsonObject["key"] == "number") {
				this.key = ((jsonObject["key"] + 1200) >>> 0) % Config.keys.length;
			} else if (typeof jsonObject["key"] == "string") {
				const key: string = jsonObject["key"];
				const letter: string = key.charAt(0).toUpperCase();
				const symbol: string = key.charAt(1).toLowerCase();
				const letterMap: Readonly<Dictionary<number>> = {
					"C": 0,
					"D": 2,
					"E": 4,
					"F": 5,
					"G": 7,
					"A": 9,
					"B": 11
				};
				const accidentalMap: Readonly<Dictionary<number>> = { "#": 1, "♯": 1, "b": -1, "♭": -1 };
				let index: number | undefined = letterMap[letter];
				const offset: number | undefined = accidentalMap[symbol];
				if (index != undefined) {
					if (offset != undefined) index += offset;
					if (index < 0) index += 12;
					index = index % 12;
					this.key = index;
				}
			}
		}

		if (jsonObject["beatsPerMinute"] != undefined) {
			this.tempo = clamp(Config.tempoMin, Config.tempoMax + 1, jsonObject["beatsPerMinute"] | 0);
		}

		let legacyGlobalReverb: number = 0; // In older songs, reverb was song-global, record that here and pass it to Instrument.fromJsonObject() for context.
		if (jsonObject["reverb"] != undefined) {
			legacyGlobalReverb = clamp(0, 32, jsonObject["reverb"] | 0);
		}

		if (jsonObject["beatsPerBar"] != undefined) {
			this.beatsPerBar = Math.max(
				Config.beatsPerBarMin,
				Math.min(Config.beatsPerBarMax, jsonObject["beatsPerBar"] | 0)
			);
		}

		let importedPartsPerBeat: number = 4;
		if (jsonObject["ticksPerBeat"] != undefined) {
			importedPartsPerBeat = jsonObject["ticksPerBeat"] | 0 || 4;
			this.rhythm = Config.rhythms.findIndex(rhythm => rhythm.stepsPerBeat == importedPartsPerBeat);
			if (this.rhythm == -1) {
				this.rhythm = 1;
			}
		}

		// Read limiter settings. Ranges and defaults are based on slider settings
		if (jsonObject["masterGain"] != undefined) {
			this.masterGain = Math.max(0, Math.min(5, jsonObject["masterGain"] || 0));
		} else {
			this.masterGain = 1;
		}

		if (jsonObject["limitThreshold"] != undefined) {
			this.limitThreshold = Math.max(0, Math.min(2, jsonObject["limitThreshold"] || 0));
		} else {
			this.limitThreshold = 1;
		}

		if (jsonObject["compressionThreshold"] != undefined) {
			this.compressionThreshold = Math.max(0, Math.min(1.1, jsonObject["compressionThreshold"] || 0));
		} else {
			this.compressionThreshold = 1;
		}

		if (jsonObject["limitRise"] != undefined) {
			this.limitRise = Math.max(2000, Math.min(10000, jsonObject["limitRise"] || 0));
		} else {
			this.limitRise = 4000;
		}

		if (jsonObject["limitDecay"] != undefined) {
			this.limitDecay = Math.max(1, Math.min(30, jsonObject["limitDecay"] || 0));
		} else {
			this.limitDecay = 4;
		}

		if (jsonObject["limitRatio"] != undefined) {
			this.limitRatio = Math.max(0, Math.min(11, jsonObject["limitRatio"] || 0));
		} else {
			this.limitRatio = 1;
		}

		if (jsonObject["compressionRatio"] != undefined) {
			this.compressionRatio = Math.max(0, Math.min(1.168, jsonObject["compressionRatio"] || 0));
		} else {
			this.compressionRatio = 1;
		}

		let maxInstruments: number = 1;
		let maxPatterns: number = 1;
		let maxBars: number = 1;
		if (jsonObject["channels"] != undefined) {
			for (const channelObject of jsonObject["channels"]) {
				if (channelObject["instruments"])
					maxInstruments = Math.max(maxInstruments, channelObject["instruments"].length | 0);
				if (channelObject["patterns"])
					maxPatterns = Math.max(maxPatterns, channelObject["patterns"].length | 0);
				if (channelObject["sequence"]) maxBars = Math.max(maxBars, channelObject["sequence"].length | 0);
			}
		}

		if (jsonObject["layeredInstruments"] != undefined) {
			this.layeredInstruments = !!jsonObject["layeredInstruments"];
		} else {
			this.layeredInstruments = false;
		}
		if (jsonObject["patternInstruments"] != undefined) {
			this.patternInstruments = !!jsonObject["patternInstruments"];
		} else {
			this.patternInstruments = maxInstruments > 1;
		}
		this.patternsPerChannel = Math.min(maxPatterns, Config.barCountMax);
		this.barCount = Math.min(maxBars, Config.barCountMax);

		if (jsonObject["introBars"] != undefined) {
			this.loopStart = clamp(0, this.barCount, jsonObject["introBars"] | 0);
		}
		if (jsonObject["loopBars"] != undefined) {
			this.loopLength = clamp(1, this.barCount - this.loopStart + 1, jsonObject["loopBars"] | 0);
		}

		const newPitchChannels: Channel[] = [];
		const newNoiseChannels: Channel[] = [];
		const newModChannels: Channel[] = [];
		if (jsonObject["channels"] != undefined) {
			for (let channelIndex: number = 0; channelIndex < jsonObject["channels"].length; channelIndex++) {
				let channelObject: any = jsonObject["channels"][channelIndex];

				const channel: Channel = new Channel();

				let isNoiseChannel: boolean = false;
				let isModChannel: boolean = false;
				if (channelObject["type"] != undefined) {
					isNoiseChannel = channelObject["type"] == "drum";
					isModChannel = channelObject["type"] == "mod";
				} else {
					// for older files, assume drums are channel 3.
					isNoiseChannel = channelIndex >= 3;
				}
				if (isNoiseChannel) {
					newNoiseChannels.push(channel);
				} else if (isModChannel) {
					newModChannels.push(channel);
				} else {
					newPitchChannels.push(channel);
				}

				if (channelObject["octaveScrollBar"] != undefined) {
					channel.octave = clamp(0, Config.pitchOctaves, (channelObject["octaveScrollBar"] | 0) + 1);
					if (isNoiseChannel) channel.octave = 0;
				}

				if (channelObject["name"] != undefined) {
					channel.name = channelObject["name"];
				} else {
					channel.name = "";
				}

				if (Array.isArray(channelObject["instruments"])) {
					const instrumentObjects: any[] = channelObject["instruments"];
					for (let i: number = 0; i < instrumentObjects.length; i++) {
						if (i >= this.getMaxInstrumentsPerChannel()) break;
						const instrument: Instrument = new Instrument(isNoiseChannel, isModChannel);
						channel.instruments[i] = instrument;
						instrument.fromJsonObject(
							instrumentObjects[i],
							isNoiseChannel,
							isModChannel,
							false,
							false,
							legacyGlobalReverb
						);
					}
				}

				for (let i: number = 0; i < this.patternsPerChannel; i++) {
					const pattern: Pattern = new Pattern();
					channel.patterns[i] = pattern;

					let patternObject: any = undefined;
					if (channelObject["patterns"]) patternObject = channelObject["patterns"][i];
					if (patternObject == undefined) continue;

					pattern.fromJsonObject(
						patternObject,
						this,
						channel,
						importedPartsPerBeat,
						isNoiseChannel,
						isModChannel
					);
				}
				channel.patterns.length = this.patternsPerChannel;

				for (let i: number = 0; i < this.barCount; i++) {
					channel.bars[i] =
						channelObject["sequence"] != undefined
							? Math.min(this.patternsPerChannel, channelObject["sequence"][i] >>> 0)
							: 0;
				}
				channel.bars.length = this.barCount;
			}
		}

		if (newPitchChannels.length > Config.pitchChannelCountMax)
			newPitchChannels.length = Config.pitchChannelCountMax;
		if (newNoiseChannels.length > Config.noiseChannelCountMax)
			newNoiseChannels.length = Config.noiseChannelCountMax;
		if (newModChannels.length > Config.modChannelCountMax) newModChannels.length = Config.modChannelCountMax;
		this.pitchChannelCount = newPitchChannels.length;
		this.noiseChannelCount = newNoiseChannels.length;
		this.modChannelCount = newModChannels.length;
		this.channels.length = 0;
		Array.prototype.push.apply(this.channels, newPitchChannels);
		Array.prototype.push.apply(this.channels, newNoiseChannels);
		Array.prototype.push.apply(this.channels, newModChannels);
	}

	public getPattern(channelIndex: number, bar: number): Pattern | null {
		if (bar < 0 || bar >= this.barCount) return null;
		const patternIndex: number = this.channels[channelIndex].bars[bar];
		if (patternIndex == 0) return null;
		return this.channels[channelIndex].patterns[patternIndex - 1];
	}

	public getBeatsPerMinute(): number {
		return this.tempo;
	}

	public static getNeededBits(maxValue: number): number {
		return 32 - Math.clz32(Math.ceil(maxValue + 1) - 1);
	}

	public restoreLimiterDefaults(): void {
		this.compressionRatio = 1;
		this.limitRatio = 1;
		this.limitRise = 4000;
		this.limitDecay = 4;
		this.limitThreshold = 1;
		this.compressionThreshold = 1;
		this.masterGain = 1;
	}
}
