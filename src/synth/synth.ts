/** @format */

// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

import {
	Dictionary,
	DictionaryArray,
	EnvelopeType,
	FilterType,
	InstrumentType,
	EffectType,
	EnvelopeComputeIndex,
	Transition,
	Unison,
	Chord,
	Envelope,
	Config,
	getArpeggioPitchIndex,
	getPulseWidthRatio,
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
import { Deque } from "./Deque";
import { FilterCoefficients, FrequencyResponse, DynamicBiquadFilter } from "./filtering";
import { Note } from "./Note";
import { NotePin } from "./Note";
import { Pattern } from "./Pattern";
import { Instrument } from "./Instrument";
import { Song } from "./Song";
import { FilterSettings } from "./Filter";
import { FilterControlPoint } from "./Filter";
import { PickedString } from "./PickedString";
import { EnvelopeComputer } from "./Envelope";
import { Tone } from "./Tone";
import { InstrumentState } from "./Instrument";

declare global {
	interface Window {
		AudioContext: any;
		webkitAudioContext: any;
	}
}

const epsilon: number = 1.0e-24; // For detecting and avoiding float denormals, which have poor performance.

// For performance debugging:
//let samplesAccumulated: number = 0;
//let samplePerformance: number = 0;

export function clamp(min: number, max: number, val: number): number {
	max = max - 1;
	if (val <= max) {
		if (val >= min) return val;
		else return min;
	} else {
		return max;
	}
}

export function validateRange(min: number, max: number, val: number): number {
	if (min <= val && val <= max) return val;
	throw new Error(`Value ${val} not in range [${min}, ${max}]`);
}

export class Operator {
	public frequency: number = 0;
	public amplitude: number = 0;
	public waveform: number = 0;
	public pulseWidth: number = 0.5;

	constructor(index: number) {
		this.reset(index);
	}

	public reset(index: number): void {
		this.frequency = 0;
		this.amplitude = index <= 1 ? Config.operatorAmplitudeMax : 0;
		this.waveform = 0;
		this.pulseWidth = 5;
	}

	public copy(other: Operator): void {
		this.frequency = other.frequency;
		this.amplitude = other.amplitude;
		this.waveform = other.waveform;
		this.pulseWidth = other.pulseWidth;
	}
}

// Settings that were available to old versions of BeepBox but are no longer available in the
// current version that need to be reinterpreted as a group to determine the best way to
// represent them in the current version.
export interface LegacySettings {
	filterCutoff?: number;
	filterResonance?: number;
	filterEnvelope?: Envelope;
	pulseEnvelope?: Envelope;
	operatorEnvelopes?: Envelope[];
	feedbackEnvelope?: Envelope;
}

export class Channel {
	public octave: number = 0;
	public readonly instruments: Instrument[] = [];
	public readonly patterns: Pattern[] = [];
	public readonly bars: number[] = [];
	public muted: boolean = false;
	public name: string = "";
}

class ChannelState {
	public readonly instruments: InstrumentState[] = [];
	public muted: boolean = false;
	public singleSeamlessInstrument: number | null = null; // Seamless tones from a pattern with a single instrument can be transferred to a different single seamless instrument in the next pattern.
}

export class Synth {
	private syncSongState(): void {
		const channelCount: number = this.song!.getChannelCount();
		for (let i: number = this.channels.length; i < channelCount; i++) {
			this.channels[i] = new ChannelState();
		}
		this.channels.length = channelCount;
		for (let i: number = 0; i < channelCount; i++) {
			const channel: Channel = this.song!.channels[i];
			const channelState: ChannelState = this.channels[i];
			for (let j: number = channelState.instruments.length; j < channel.instruments.length; j++) {
				channelState.instruments[j] = new InstrumentState();
			}
			channelState.instruments.length = channel.instruments.length;

			if (channelState.muted != channel.muted) {
				channelState.muted = channel.muted;
				if (channelState.muted) {
					for (const instrumentState of channelState.instruments) {
						instrumentState.resetAllEffects();
					}
				}
			}
		}
	}

	public warmUpSynthesizer(song: Song | null): void {
		// Don't bother to generate the drum waves unless the song actually
		// uses them, since they may require a lot of computation.
		if (song != null) {
			this.syncSongState();
			const samplesPerTick: number = this.getSamplesPerTick();
			for (let channelIndex: number = 0; channelIndex < song.getChannelCount(); channelIndex++) {
				for (
					let instrumentIndex: number = 0;
					instrumentIndex < song.channels[channelIndex].instruments.length;
					instrumentIndex++
				) {
					const instrument: Instrument = song.channels[channelIndex].instruments[instrumentIndex];
					const instrumentState: InstrumentState = this.channels[channelIndex].instruments[instrumentIndex];
					Synth.getInstrumentSynthFunction(instrument);
					instrument.LFOtime = 0;
					instrument.nextLFOtime = 0;
					instrument.arpTime = 0;
					instrument.tmpEqFilterStart = instrument.eqFilter;
					instrument.tmpEqFilterEnd = null;
					instrument.tmpNoteFilterStart = instrument.noteFilter;
					instrument.tmpNoteFilterEnd = null;
					instrumentState.updateWaves(instrument, this.samplesPerSecond);
					instrumentState.allocateNecessaryBuffers(this, instrument, samplesPerTick);
				}
			}
		}
		var dummyArray = new Float32Array(1);
		this.isPlayingSong = true;
		this.synthesize(dummyArray, dummyArray, 1, true);
		this.isPlayingSong = false;
	}

	public computeLatestModValues(): void {
		if (this.song != null && this.song.modChannelCount > 0) {
			// Clear all mod values, and set up temp variables for the time a mod would be set at.
			let latestModTimes: (number | null)[] = [];
			let latestModInsTimes: (number | null)[][][] = [];
			this.modValues = [];
			this.nextModValues = [];
			this.modInsValues = [];
			this.nextModInsValues = [];
			for (
				let channel: number = 0;
				channel < this.song.pitchChannelCount + this.song.noiseChannelCount;
				channel++
			) {
				latestModInsTimes[channel] = [];
				this.modInsValues[channel] = [];
				this.nextModInsValues[channel] = [];

				for (
					let instrument: number = 0;
					instrument < this.song.channels[channel].instruments.length;
					instrument++
				) {
					this.modInsValues[channel][instrument] = [];
					this.nextModInsValues[channel][instrument] = [];
					latestModInsTimes[channel][instrument] = [];
				}
			}

			// Find out where we're at in the fraction of the current bar.
			let currentPart: number = this.beat * Config.partsPerBeat + this.part;

			// For mod channels, calculate last set value for each mod
			for (
				let channelIndex: number = this.song.pitchChannelCount + this.song.noiseChannelCount;
				channelIndex < this.song.getChannelCount();
				channelIndex++
			) {
				if (!this.song.channels[channelIndex].muted) {
					let pattern: Pattern | null;

					for (let currentBar: number = this.bar; currentBar >= 0; currentBar--) {
						pattern = this.song.getPattern(channelIndex, currentBar);

						if (pattern != null) {
							let instrumentIdx: number = pattern.instruments[0];
							let instrument: Instrument = this.song.channels[channelIndex].instruments[instrumentIdx];
							let latestPinParts: number[] = [];
							let latestPinValues: number[] = [];

							let partsInBar: number =
								currentBar == this.bar ? currentPart : this.findPartsInBar(currentBar);

							for (const note of pattern.notes) {
								if (
									note.start < partsInBar &&
									(latestPinParts[Config.modCount - 1 - note.pitches[0]] == null ||
										note.end > latestPinParts[Config.modCount - 1 - note.pitches[0]])
								) {
									if (note.end <= partsInBar) {
										latestPinParts[Config.modCount - 1 - note.pitches[0]] = note.end;
										latestPinValues[Config.modCount - 1 - note.pitches[0]] =
											note.pins[note.pins.length - 1].size;
									} else {
										latestPinParts[Config.modCount - 1 - note.pitches[0]] = partsInBar;
										// Find the pin where bar change happens, and compute where pin volume would be at that time
										for (let pinIdx = 0; pinIdx < note.pins.length; pinIdx++) {
											if (note.pins[pinIdx].time + note.start > partsInBar) {
												const transitionLength: number =
													note.pins[pinIdx].time - note.pins[pinIdx - 1].time;
												const toNextBarLength: number =
													partsInBar - note.start - note.pins[pinIdx - 1].time;
												const deltaVolume: number =
													note.pins[pinIdx].size - note.pins[pinIdx - 1].size;

												latestPinValues[Config.modCount - 1 - note.pitches[0]] = Math.round(
													note.pins[pinIdx - 1].size +
														(deltaVolume * toNextBarLength) / transitionLength
												);
												pinIdx = note.pins.length;
											}
										}
									}
								}
							}

							// Set modulator value, if it wasn't set in another pattern already scanned
							for (let mod: number = 0; mod < Config.modCount; mod++) {
								if (latestPinParts[mod] != null) {
									if (Config.modulators[instrument.modulators[mod]].forSong) {
										if (
											latestModTimes[instrument.modulators[mod]] == null ||
											currentBar * Config.partsPerBeat * this.song.beatsPerBar +
												latestPinParts[mod] >
												(latestModTimes[instrument.modulators[mod]] as number)
										) {
											this.setModValue(
												latestPinValues[mod],
												latestPinValues[mod],
												mod,
												instrument.modChannels[mod],
												instrument.modInstruments[mod],
												instrument.modulators[mod]
											);
											latestModTimes[instrument.modulators[mod]] =
												currentBar * Config.partsPerBeat * this.song.beatsPerBar +
												latestPinParts[mod];
										}
									} else {
										// Generate list of used instruments
										let usedInstruments: number[] = [];
										// All
										if (
											instrument.modInstruments[mod] ==
											this.song.channels[instrument.modChannels[mod]].instruments.length
										) {
											for (
												let i: number = 0;
												i < this.song.channels[instrument.modChannels[mod]].instruments.length;
												i++
											) {
												usedInstruments.push(i);
											}
										}
										// Active
										else if (
											instrument.modInstruments[mod] >
											this.song.channels[instrument.modChannels[mod]].instruments.length
										) {
											const tgtPattern: Pattern | null = this.song.getPattern(
												instrument.modChannels[mod],
												currentBar
											);
											if (tgtPattern != null) usedInstruments = tgtPattern.instruments;
										} else {
											usedInstruments.push(instrument.modInstruments[mod]);
										}
										for (
											let instrumentIndex: number = 0;
											instrumentIndex < usedInstruments.length;
											instrumentIndex++
										) {
											// Iterate through all used instruments by this modulator
											// Special indices for mod filter targets, since they control multiple things.
											const eqFilterParam: boolean =
												instrument.modulators[mod] ==
												Config.modulators.dictionary["eq filter"].index;
											const noteFilterParam: boolean =
												instrument.modulators[mod] ==
												Config.modulators.dictionary["note filter"].index;
											let modulatorAdjust: number = instrument.modulators[mod];
											if (eqFilterParam) {
												modulatorAdjust =
													Config.modulators.length + instrument.modFilterTypes[mod];
											} else if (noteFilterParam) {
												// Skip all possible indices for eq filter
												modulatorAdjust =
													Config.modulators.length +
													1 +
													2 * Config.filterMaxPoints +
													instrument.modFilterTypes[mod];
											}

											if (
												latestModInsTimes[instrument.modChannels[mod]][
													usedInstruments[instrumentIndex]
												][modulatorAdjust] == null ||
												currentBar * Config.partsPerBeat * this.song.beatsPerBar +
													latestPinParts[mod] >
													latestModInsTimes[instrument.modChannels[mod]][
														usedInstruments[instrumentIndex]
													][modulatorAdjust]!
											) {
												if (eqFilterParam) {
													let tgtInstrument: Instrument =
														this.song.channels[instrument.modChannels[mod]].instruments[
															usedInstruments[instrumentIndex]
														];
													if (instrument.modFilterTypes[mod] == 0) {
														tgtInstrument.tmpEqFilterStart =
															tgtInstrument.eqSubFilters[latestPinValues[mod]];
													} else {
														for (let i: number = 0; i < Config.filterMorphCount; i++) {
															if (
																tgtInstrument.tmpEqFilterStart ==
																tgtInstrument.eqSubFilters[i]
															) {
																tgtInstrument.tmpEqFilterStart = new FilterSettings();
																tgtInstrument.tmpEqFilterStart.fromJsonObject(
																	tgtInstrument.eqSubFilters[i]!.toJsonObject()
																);
																i = Config.filterMorphCount;
															}
														}
														if (
															Math.floor((instrument.modFilterTypes[mod] - 1) / 2) <
															tgtInstrument.tmpEqFilterStart!.controlPointCount
														) {
															if (instrument.modFilterTypes[mod] % 2)
																tgtInstrument.tmpEqFilterStart!.controlPoints[
																	Math.floor((instrument.modFilterTypes[mod] - 1) / 2)
																].freq = latestPinValues[mod];
															else
																tgtInstrument.tmpEqFilterStart!.controlPoints[
																	Math.floor((instrument.modFilterTypes[mod] - 1) / 2)
																].gain = latestPinValues[mod];
														}
													}
													tgtInstrument.tmpEqFilterEnd = tgtInstrument.tmpEqFilterStart;
												} else if (noteFilterParam) {
													let tgtInstrument: Instrument =
														this.song.channels[instrument.modChannels[mod]].instruments[
															usedInstruments[instrumentIndex]
														];
													if (instrument.modFilterTypes[mod] == 0) {
														tgtInstrument.tmpNoteFilterStart =
															tgtInstrument.noteSubFilters[latestPinValues[mod]];
													} else {
														for (let i: number = 0; i < Config.filterMorphCount; i++) {
															if (
																tgtInstrument.tmpNoteFilterStart ==
																tgtInstrument.noteSubFilters[i]
															) {
																tgtInstrument.tmpNoteFilterStart = new FilterSettings();
																tgtInstrument.tmpNoteFilterStart.fromJsonObject(
																	tgtInstrument.noteSubFilters[i]!.toJsonObject()
																);
																i = Config.filterMorphCount;
															}
														}
														if (
															Math.floor((instrument.modFilterTypes[mod] - 1) / 2) <
															tgtInstrument.tmpNoteFilterStart!.controlPointCount
														) {
															if (instrument.modFilterTypes[mod] % 2)
																tgtInstrument.tmpNoteFilterStart!.controlPoints[
																	Math.floor((instrument.modFilterTypes[mod] - 1) / 2)
																].freq = latestPinValues[mod];
															else
																tgtInstrument.tmpNoteFilterStart!.controlPoints[
																	Math.floor((instrument.modFilterTypes[mod] - 1) / 2)
																].gain = latestPinValues[mod];
														}
													}
													tgtInstrument.tmpNoteFilterEnd = tgtInstrument.tmpNoteFilterStart;
												} else
													this.setModValue(
														latestPinValues[mod],
														latestPinValues[mod],
														mod,
														instrument.modChannels[mod],
														usedInstruments[instrumentIndex],
														modulatorAdjust
													);

												latestModInsTimes[instrument.modChannels[mod]][
													usedInstruments[instrumentIndex]
												][modulatorAdjust] =
													currentBar * Config.partsPerBeat * this.song.beatsPerBar +
													latestPinParts[mod];
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}
	}

	// Detects if a modulator is set, but not valid for the current effects/instrument type/filter type
	// Note, setting 'none' or the intermediary steps when clicking to add a mod, like an unset channel/unset instrument, counts as valid.
	// TODO: This kind of check is mirrored in SongEditor.ts' whenUpdated. Creates a lot of redundancy for adding new mods. Can be moved into new properties for mods, to avoid this later.
	public determineInvalidModulators(instrument: Instrument): void {
		if (this.song == null) return;
		for (let mod: number = 0; mod < Config.modCount; mod++) {
			instrument.invalidModulators[mod] = true;
			// For song modulator, valid if any setting used
			if (instrument.modChannels[mod] == -1) {
				if (instrument.modulators[mod] != 0) instrument.invalidModulators[mod] = false;
				continue;
			}
			const channel: Channel | null = this.song.channels[instrument.modChannels[mod]];
			if (channel == null) continue;
			let tgtInstrumentList: Instrument[] = [];
			if (instrument.modInstruments[mod] >= channel.instruments.length) {
				// All or active
				tgtInstrumentList = channel.instruments;
			} else {
				tgtInstrumentList = [channel.instruments[instrument.modInstruments[mod]]];
			}
			for (let i: number = 0; i < tgtInstrumentList.length; i++) {
				const tgtInstrument: Instrument | null = tgtInstrumentList[i];
				if (tgtInstrument == null) continue;
				const str: string = Config.modulators[instrument.modulators[mod]].name;
				// Check effects
				if (
					!(
						(Config.modulators[instrument.modulators[mod]].associatedEffect != EffectType.length &&
							!(
								tgtInstrument.effects &
								(1 << Config.modulators[instrument.modulators[mod]].associatedEffect)
							)) ||
						// Instrument type specific
						(tgtInstrument.type != InstrumentType.fm &&
							(str == "fm slider 1" ||
								str == "fm slider 2" ||
								str == "fm slider 3" ||
								str == "fm slider 4" ||
								str == "fm feedback")) ||
						(tgtInstrument.type != InstrumentType.pwm && str == "pulse width") ||
						// Arp check
						(!tgtInstrument.getChord().arpeggiates && (str == "arp speed" || str == "reset arp")) ||
						// EQ Filter check
						(tgtInstrument.eqFilterType && str == "eq filter") ||
						(!tgtInstrument.eqFilterType && (str == "eq filt cut" || str == "eq filt peak")) ||
						(str == "eq filter" &&
							Math.floor((instrument.modFilterTypes[mod] + 1) / 2) >
								tgtInstrument.eqFilter.controlPointCount) ||
						// Note Filter check
						(tgtInstrument.noteFilterType && str == "note filter") ||
						(!tgtInstrument.noteFilterType && (str == "note filt cut" || str == "note filt peak")) ||
						(str == "note filter" &&
							Math.floor((instrument.modFilterTypes[mod] + 1) / 2) >
								tgtInstrument.noteFilter.controlPointCount)
					)
				) {
					instrument.invalidModulators[mod] = false;
					i = tgtInstrumentList.length;
				}
			}
		}
	}

	private static operatorAmplitudeCurve(amplitude: number): number {
		return (Math.pow(16.0, amplitude / 15.0) - 1.0) / 15.0;
	}

	public samplesPerSecond: number = 44100;
	public panningDelayBufferSize: number;
	public panningDelayBufferMask: number;
	public chorusDelayBufferSize: number;
	public chorusDelayBufferMask: number;
	// TODO: reverb

	public song: Song | null = null;
	public preferLowerLatency: boolean = false; // enable when recording performances from keyboard or MIDI. Takes effect next time you activate audio.
	public anticipatePoorPerformance: boolean = false; // enable on mobile devices to reduce audio stutter glitches. Takes effect next time you activate audio.
	public liveInputDuration: number = 0;
	public liveInputStarted: boolean = false;
	public liveInputPitches: number[] = [];
	public liveInputChannel: number = 0;
	public liveInputInstruments: number[] = [];
	public loopRepeatCount: number = -1;
	public volume: number = 1.0;
	public enableMetronome: boolean = false;
	public countInMetronome: boolean = false;
	public renderingSong: boolean = false;

	private wantToSkip: boolean = false;
	private playheadInternal: number = 0.0;
	private bar: number = 0;
	private prevBar: number | null = null;
	private nextBar: number | null = null;
	private beat: number = 0;
	private part: number = 0;
	private tick: number = 0;
	public isAtStartOfTick: boolean = true;
	public isAtEndOfTick: boolean = true;
	public tickSampleCountdown: number = 0;
	private modValues: (number | null)[] = [];
	private modInsValues: (number | null)[][][] = [];
	private nextModValues: (number | null)[] = [];
	private nextModInsValues: (number | null)[][][] = [];
	private isPlayingSong: boolean = false;
	private isRecording: boolean = false;
	private liveInputEndTime: number = 0.0;
	private browserAutomaticallyClearsAudioBuffer: boolean = true; // Assume true until proven otherwise. Older Chrome does not clear the buffer so it needs to be cleared manually.

	public static readonly tempFilterStartCoefficients: FilterCoefficients = new FilterCoefficients();
	public static readonly tempFilterEndCoefficients: FilterCoefficients = new FilterCoefficients();
	private tempDrumSetControlPoint: FilterControlPoint = new FilterControlPoint();
	public tempFrequencyResponse: FrequencyResponse = new FrequencyResponse();

	private static readonly fmSynthFunctionCache: Dictionary<Function> = {};
	private static readonly effectsFunctionCache: Function[] = Array(1 << 7).fill(undefined); // keep in sync with the number of post-process effects.
	private static readonly pickedStringFunctionCache: Function[] = Array(3).fill(undefined); // keep in sync with the number of unison voices.

	private readonly channels: ChannelState[] = [];
	private readonly tonePool: Deque<Tone> = new Deque<Tone>();
	private readonly tempMatchedPitchTones: Array<Tone | null> = Array(Config.maxChordSize).fill(null);

	private startedMetronome: boolean = false;
	private metronomeSamplesRemaining: number = -1;
	private metronomeAmplitude: number = 0.0;
	private metronomePrevAmplitude: number = 0.0;
	private metronomeFilter: number = 0.0;
	private limit: number = 0.0;

	private tempMonoInstrumentSampleBuffer: Float32Array | null = null;

	private audioCtx: any | null = null;
	private scriptNode: any | null = null;

	public get playing(): boolean {
		return this.isPlayingSong;
	}

	public get recording(): boolean {
		return this.isRecording;
	}

	public get playhead(): number {
		return this.playheadInternal;
	}

	public set playhead(value: number) {
		if (this.song != null) {
			this.playheadInternal = Math.max(0, Math.min(this.song.barCount, value));
			let remainder: number = this.playheadInternal;
			this.bar = Math.floor(remainder);
			remainder = this.song.beatsPerBar * (remainder - this.bar);
			this.beat = Math.floor(remainder);
			remainder = Config.partsPerBeat * (remainder - this.beat);
			this.part = Math.floor(remainder);
			remainder = Config.ticksPerPart * (remainder - this.part);
			this.tick = Math.floor(remainder);
			this.tickSampleCountdown = 0;
			this.isAtStartOfTick = true;
			this.prevBar = null;
		}
	}

	public getSamplesPerBar(): number {
		if (this.song == null) throw new Error();
		return this.getSamplesPerTick() * Config.ticksPerPart * Config.partsPerBeat * this.song.beatsPerBar;
	}

	public getTicksIntoBar(): number {
		return (this.beat * Config.partsPerBeat + this.part) * Config.ticksPerPart + this.tick;
	}
	public getCurrentPart(): number {
		return this.beat * Config.partsPerBeat + this.part;
	}

	private findPartsInBar(bar: number): number {
		if (this.song == null) return 0;
		let partsInBar: number = Config.partsPerBeat * this.song.beatsPerBar;
		for (
			let channel: number = this.song.pitchChannelCount + this.song.noiseChannelCount;
			channel < this.song.getChannelCount();
			channel++
		) {
			let pattern: Pattern | null = this.song.getPattern(channel, bar);
			if (pattern != null) {
				let instrument: Instrument = this.song.channels[channel].instruments[pattern.instruments[0]];
				for (let mod: number = 0; mod < Config.modCount; mod++) {
					if (instrument.modulators[mod] == Config.modulators.dictionary["next bar"].index) {
						for (const note of pattern.notes) {
							if (note.pitches[0] == Config.modCount - 1 - mod) {
								// Find the earliest next bar note.
								if (partsInBar > note.start) partsInBar = note.start;
							}
						}
					}
				}
			}
		}
		return partsInBar;
	}

	// Returns the total samples in the song
	public getTotalSamples(enableIntro: boolean, enableOutro: boolean, loop: number): number {
		if (this.song == null) return -1;

		// Compute the window to be checked (start bar to end bar)
		let startBar: number = enableIntro ? 0 : this.song.loopStart;
		let endBar: number = enableOutro ? this.song.barCount : this.song.loopStart + this.song.loopLength;
		let hasTempoMods: boolean = false;
		let hasNextBarMods: boolean = false;
		let prevTempo: number = this.song.tempo;

		// Determine if any tempo or next bar mods happen anywhere in the window
		for (
			let channel: number = this.song.pitchChannelCount + this.song.noiseChannelCount;
			channel < this.song.getChannelCount();
			channel++
		) {
			for (let bar: number = startBar; bar < endBar; bar++) {
				let pattern: Pattern | null = this.song.getPattern(channel, bar);
				if (pattern != null) {
					let instrument: Instrument = this.song.channels[channel].instruments[pattern.instruments[0]];
					for (let mod: number = 0; mod < Config.modCount; mod++) {
						if (instrument.modulators[mod] == Config.modulators.dictionary["tempo"].index) {
							hasTempoMods = true;
						}
						if (instrument.modulators[mod] == Config.modulators.dictionary["next bar"].index) {
							hasNextBarMods = true;
						}
					}
				}
			}
		}

		// If intro is not zero length, determine what the "entry" tempo is going into the start part, by looking at mods that came before...
		if (startBar > 0) {
			let latestTempoPin: number | null = null;
			let latestTempoValue: number = 0;

			for (let bar: number = startBar - 1; bar >= 0; bar--) {
				for (
					let channel: number = this.song.pitchChannelCount + this.song.noiseChannelCount;
					channel < this.song.getChannelCount();
					channel++
				) {
					let pattern = this.song.getPattern(channel, bar);

					if (pattern != null) {
						let instrumentIdx: number = pattern.instruments[0];
						let instrument: Instrument = this.song.channels[channel].instruments[instrumentIdx];

						let partsInBar: number = this.findPartsInBar(bar);

						for (const note of pattern.notes) {
							if (
								instrument.modulators[Config.modCount - 1 - note.pitches[0]] ==
								Config.modulators.dictionary["tempo"].index
							) {
								if (note.start < partsInBar && (latestTempoPin == null || note.end > latestTempoPin)) {
									if (note.end <= partsInBar) {
										latestTempoPin = note.end;
										latestTempoValue = note.pins[note.pins.length - 1].size;
									} else {
										latestTempoPin = partsInBar;
										// Find the pin where bar change happens, and compute where pin volume would be at that time
										for (let pinIdx = 0; pinIdx < note.pins.length; pinIdx++) {
											if (note.pins[pinIdx].time + note.start > partsInBar) {
												const transitionLength: number =
													note.pins[pinIdx].time - note.pins[pinIdx - 1].time;
												const toNextBarLength: number =
													partsInBar - note.start - note.pins[pinIdx - 1].time;
												const deltaVolume: number =
													note.pins[pinIdx].size - note.pins[pinIdx - 1].size;

												latestTempoValue = Math.round(
													note.pins[pinIdx - 1].size +
														(deltaVolume * toNextBarLength) / transitionLength
												);
												pinIdx = note.pins.length;
											}
										}
									}
								}
							}
						}
					}
				}

				// Done once you process a pattern where tempo mods happened, since the search happens backward
				if (latestTempoPin != null) {
					prevTempo = latestTempoValue + Config.modulators.dictionary["tempo"].convertRealFactor;
					bar = -1;
				}
			}
		}

		if (hasTempoMods || hasNextBarMods) {
			// Run from start bar to end bar and observe looping, computing average tempo across each bar
			let bar: number = startBar;
			let ended: boolean = false;
			let totalSamples: number = 0;

			while (!ended) {
				// Compute the subsection of the pattern that will play
				let partsInBar: number = Config.partsPerBeat * this.song.beatsPerBar;
				let currentPart: number = 0;

				if (hasNextBarMods) {
					partsInBar = this.findPartsInBar(bar);
				}

				// Compute average tempo in this tick window, or use last tempo if nothing happened
				if (hasTempoMods) {
					let foundMod: boolean = false;
					for (
						let channel: number = this.song.pitchChannelCount + this.song.noiseChannelCount;
						channel < this.song.getChannelCount();
						channel++
					) {
						if (foundMod == false) {
							let pattern: Pattern | null = this.song.getPattern(channel, bar);
							if (pattern != null) {
								let instrument: Instrument =
									this.song.channels[channel].instruments[pattern.instruments[0]];
								for (let mod: number = 0; mod < Config.modCount; mod++) {
									if (
										foundMod == false &&
										instrument.modulators[mod] == Config.modulators.dictionary["tempo"].index &&
										pattern.notes.find(n => n.pitches[0] == Config.modCount - 1 - mod)
									) {
										// Only the first tempo mod instrument for this bar will be checked (well, the first with a note in this bar).
										foundMod = true;
										// Need to re-sort the notes by start time to make the next part much less painful.
										pattern.notes.sort(function (a, b) {
											return a.start == b.start ? a.pitches[0] - b.pitches[0] : a.start - b.start;
										});
										for (const note of pattern.notes) {
											if (note.pitches[0] == Config.modCount - 1 - mod) {
												// Compute samples up to this note
												totalSamples +=
													Math.min(partsInBar - currentPart, note.start - currentPart) *
													Config.ticksPerPart *
													this.getSamplesPerTickSpecificBPM(prevTempo);

												if (note.start < partsInBar) {
													for (let pinIdx: number = 1; pinIdx < note.pins.length; pinIdx++) {
														// Compute samples up to this pin
														if (note.pins[pinIdx - 1].time + note.start <= partsInBar) {
															const tickLength: number =
																Config.ticksPerPart *
																Math.min(
																	partsInBar -
																		(note.start + note.pins[pinIdx - 1].time),
																	note.pins[pinIdx].time - note.pins[pinIdx - 1].time
																);
															const prevPinTempo: number =
																note.pins[pinIdx - 1].size +
																Config.modulators.dictionary["tempo"].convertRealFactor;
															let currPinTempo: number =
																note.pins[pinIdx].size +
																Config.modulators.dictionary["tempo"].convertRealFactor;
															if (note.pins[pinIdx].time + note.start > partsInBar) {
																// Compute an intermediary tempo since bar changed over mid-pin. Maybe I'm deep in "what if" territory now!
																currPinTempo =
																	note.pins[pinIdx - 1].size +
																	((note.pins[pinIdx].size -
																		note.pins[pinIdx - 1].size) *
																		(partsInBar -
																			(note.start +
																				note.pins[pinIdx - 1].time))) /
																		(note.pins[pinIdx].time -
																			note.pins[pinIdx - 1].time) +
																	Config.modulators.dictionary["tempo"]
																		.convertRealFactor;
															}
															let bpmScalar: number =
																(Config.partsPerBeat * Config.ticksPerPart) / 60;

															if (currPinTempo != prevPinTempo) {
																// Definite integral of SamplesPerTick w/r/t beats to find total samples from start point to end point for a variable tempo
																// The starting formula is
																// SamplesPerTick = SamplesPerSec / ((PartsPerBeat * TicksPerPart) / SecPerMin) * BeatsPerMin )
																//
																// This is an expression of samples per tick "instantaneously", and it can be multiplied by a number of ticks to get a sample count.
																// But this isn't the full story. BeatsPerMin, e.g. tempo, changes throughout the interval so it has to be expressed in terms of ticks, "t"
																// ( Also from now on PartsPerBeat, TicksPerPart, and SecPerMin are combined into one scalar, called "BPMScalar" )
																// Substituting BPM for a step variable that moves with respect to the current tick, we get
																// SamplesPerTick = SamplesPerSec / (BPMScalar * ( (EndTempo - StartTempo / TickLength) * t + StartTempo ) )
																//
																// When this equation is integrated from 0 to TickLength with respect to t, we get the following expression:
																//   Samples = - SamplesPerSec * TickLength * ( log( BPMScalar * EndTempo * TickLength ) - log( BPMScalar * StartTempo * TickLength ) ) / BPMScalar * ( StartTempo - EndTempo )

																totalSamples +=
																	(-this.samplesPerSecond *
																		tickLength *
																		(Math.log(
																			bpmScalar * currPinTempo * tickLength
																		) -
																			Math.log(
																				bpmScalar * prevPinTempo * tickLength
																			))) /
																	(bpmScalar * (prevPinTempo - currPinTempo));
															} else {
																// No tempo change between the two pins.
																totalSamples +=
																	tickLength *
																	this.getSamplesPerTickSpecificBPM(currPinTempo);
															}
															prevTempo = currPinTempo;
														}
														currentPart = Math.min(
															note.start + note.pins[pinIdx].time,
															partsInBar
														);
													}
												}
											}
										}
									}
								}
							}
						}
					}
				}

				// Compute samples for the rest of the bar
				totalSamples +=
					(partsInBar - currentPart) * Config.ticksPerPart * this.getSamplesPerTickSpecificBPM(prevTempo);

				bar++;
				if (loop != 0 && bar == this.song.loopStart + this.song.loopLength) {
					bar = this.song.loopStart;
					if (loop > 0) loop--;
				}
				if (bar >= endBar) {
					ended = true;
				}
			}

			return Math.ceil(totalSamples);
		} else {
			// No tempo or next bar mods... phew! Just calculate normally.
			return this.getSamplesPerBar() * this.getTotalBars(enableIntro, enableOutro, loop);
		}
	}

	public getTotalBars(
		enableIntro: boolean,
		enableOutro: boolean,
		useLoopCount: number = this.loopRepeatCount
	): number {
		if (this.song == null) throw new Error();
		let bars: number = this.song.loopLength * (useLoopCount + 1);
		if (enableIntro) bars += this.song.loopStart;
		if (enableOutro) bars += this.song.barCount - (this.song.loopStart + this.song.loopLength);
		return bars;
	}

	constructor(song: Song | string | null = null) {
		this.computeDelayBufferSizes();
		if (song != null) this.setSong(song);
	}

	public setSong(song: Song | string): void {
		if (typeof song == "string") {
			this.song = new Song(song);
		} else if (song instanceof Song) {
			this.song = song;
		}
		this.prevBar = null;
	}

	private computeDelayBufferSizes(): void {
		this.panningDelayBufferSize = Synth.fittingPowerOfTwo(this.samplesPerSecond * Config.panDelaySecondsMax);
		this.panningDelayBufferMask = this.panningDelayBufferSize - 1;
		this.chorusDelayBufferSize = Synth.fittingPowerOfTwo(this.samplesPerSecond * Config.chorusMaxDelay);
		this.chorusDelayBufferMask = this.chorusDelayBufferSize - 1;
	}

	private activateAudio(): void {
		const bufferSize: number = this.anticipatePoorPerformance
			? this.preferLowerLatency
				? 2048
				: 4096
			: this.preferLowerLatency
			? 512
			: 2048;
		if (this.audioCtx == null || this.scriptNode == null || this.scriptNode.bufferSize != bufferSize) {
			if (this.scriptNode != null) this.deactivateAudio();
			const latencyHint: string = this.anticipatePoorPerformance
				? this.preferLowerLatency
					? "balanced"
					: "playback"
				: this.preferLowerLatency
				? "interactive"
				: "balanced";
			this.audioCtx =
				this.audioCtx || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: latencyHint });
			this.samplesPerSecond = this.audioCtx.sampleRate;
			this.scriptNode = this.audioCtx.createScriptProcessor
				? this.audioCtx.createScriptProcessor(bufferSize, 0, 2)
				: this.audioCtx.createJavaScriptNode(bufferSize, 0, 2); // bufferSize samples per callback buffer, 0 input channels, 2 output channels (left/right)
			this.scriptNode.onaudioprocess = this.audioProcessCallback;
			this.scriptNode.channelCountMode = "explicit";
			this.scriptNode.channelInterpretation = "speakers";
			this.scriptNode.connect(this.audioCtx.destination);

			this.computeDelayBufferSizes();
		}
		this.audioCtx.resume();
	}

	private deactivateAudio(): void {
		if (this.audioCtx != null && this.scriptNode != null) {
			this.scriptNode.disconnect(this.audioCtx.destination);
			this.scriptNode = null;
			if (this.audioCtx.close) this.audioCtx.close(); // firefox is missing this function?
			this.audioCtx = null;
		}
	}

	public maintainLiveInput(): void {
		this.activateAudio();
		this.liveInputEndTime = performance.now() + 10000.0;
	}

	public play(): void {
		if (this.isPlayingSong) return;
		this.computeLatestModValues();
		this.warmUpSynthesizer(this.song);
		this.isPlayingSong = true;
		this.activateAudio();
	}

	public pause(): void {
		if (!this.isPlayingSong) return;
		this.isPlayingSong = false;
		this.isRecording = false;
		this.modValues = [];
		this.nextModValues = [];
		if (this.song != null) {
			this.song.inVolumeCap = 0.0;
			this.song.outVolumeCap = 0.0;
			for (
				let channelIndex: number = 0;
				channelIndex < this.song.pitchChannelCount + this.song.noiseChannelCount;
				channelIndex++
			) {
				this.modInsValues[channelIndex] = [];
				this.nextModInsValues[channelIndex] = [];
			}
		}
	}

	public startRecording(): void {
		this.preferLowerLatency = true;
		this.isRecording = true;
		this.play();
	}

	public resetEffects(): void {
		this.limit = 0.0;
		this.freeAllTones();
		if (this.song != null) {
			for (const channelState of this.channels) {
				for (const instrumentState of channelState.instruments) {
					instrumentState.resetAllEffects();
				}
			}
		}
	}

	public setModValue(
		volumeStart: number,
		volumeEnd: number,
		mod: number,
		channelIndex: number,
		instrumentIndex: number,
		setting: number
	): number {
		let val: number = volumeStart + Config.modulators[setting].convertRealFactor;
		let nextVal: number = volumeEnd + Config.modulators[setting].convertRealFactor;
		if (Config.modulators[setting].forSong) {
			if (
				this.modValues[setting] == null ||
				this.modValues[setting] != val ||
				this.nextModValues[setting] != nextVal
			) {
				this.modValues[setting] = val;
				this.nextModValues[setting] = nextVal;
			}
		} else {
			if (
				this.modInsValues[channelIndex][instrumentIndex][setting] == null ||
				this.modInsValues[channelIndex][instrumentIndex][setting] != val ||
				this.nextModInsValues[channelIndex][instrumentIndex][setting] != nextVal
			) {
				this.modInsValues[channelIndex][instrumentIndex][setting] = val;
				this.nextModInsValues[channelIndex][instrumentIndex][setting] = nextVal;
			}
		}

		return val;
	}

	public getModValue(
		setting: number,
		channel?: number | null,
		instrument?: number | null,
		nextVal?: boolean
	): number {
		const forSong: boolean = Config.modulators[setting].forSong;
		if (forSong) {
			if (this.modValues[setting] != null && this.nextModValues[setting] != null) {
				return nextVal ? this.nextModValues[setting]! : this.modValues[setting]!;
			}
		} else if (channel != undefined && instrument != undefined) {
			if (
				this.modInsValues[channel][instrument][setting] != null &&
				this.nextModInsValues[channel][instrument][setting] != null
			) {
				return nextVal
					? this.nextModInsValues[channel][instrument][setting]!
					: this.modInsValues[channel][instrument][setting]!;
			}
		}
		return -1;
	}

	// Checks if any mod is active for the given channel/instrument OR if any mod is active for the song scope. Could split the logic if needed later.
	public isAnyModActive(channel: number, instrument: number): boolean {
		for (let setting: number = 0; setting < Config.modulators.length; setting++) {
			if (
				(this.modValues != undefined && this.modValues[setting] != null) ||
				(this.modInsValues != undefined &&
					this.modInsValues[channel] != undefined &&
					this.modInsValues[channel][instrument] != undefined &&
					this.modInsValues[channel][instrument][setting] != null)
			) {
				return true;
			}
		}
		return false;
	}

	public unsetMod(setting: number, channel?: number, instrument?: number) {
		if (
			this.isModActive(setting) ||
			(channel != undefined && instrument != undefined && this.isModActive(setting, channel, instrument))
		) {
			this.modValues[setting] = null;
			this.nextModValues[setting] = null;
			if (channel != undefined && instrument != undefined) {
				this.modInsValues[channel][instrument][setting] = null;
				this.nextModInsValues[channel][instrument][setting] = null;
			}
		}
	}

	public isFilterModActive(forNoteFilter: boolean, channelIdx: number, instrumentIdx: number) {
		const instrument: Instrument = this.song!.channels[channelIdx].instruments[instrumentIdx];

		if (forNoteFilter) {
			if (instrument.noteFilterType) return false;
			if (instrument.tmpNoteFilterEnd != null) return true;
		} else {
			if (instrument.eqFilterType) return false;
			if (instrument.tmpEqFilterEnd != null) return true;
		}
		return false;
	}

	public isModActive(setting: number, channel?: number, instrument?: number): boolean {
		const forSong: boolean = Config.modulators[setting].forSong;
		if (forSong) {
			return this.modValues != undefined && this.modValues[setting] != null;
		} else if (
			channel != undefined &&
			instrument != undefined &&
			this.modInsValues != undefined &&
			this.modInsValues[channel] != null &&
			this.modInsValues[channel][instrument] != null
		) {
			return this.modInsValues[channel][instrument][setting] != null;
		}
		return false;
	}

	public snapToStart(): void {
		this.bar = 0;
		this.resetEffects();
		this.snapToBar();
	}

	public goToBar(bar: number): void {
		this.bar = bar;
		this.resetEffects();
		this.playheadInternal = this.bar;
	}

	public snapToBar(): void {
		this.playheadInternal = this.bar;
		this.beat = 0;
		this.part = 0;
		this.tick = 0;
		this.tickSampleCountdown = 0;
	}

	public jumpIntoLoop(): void {
		if (!this.song) return;
		if (this.bar < this.song.loopStart || this.bar >= this.song.loopStart + this.song.loopLength) {
			const oldBar: number = this.bar;
			this.bar = this.song.loopStart;
			this.playheadInternal += this.bar - oldBar;

			if (this.playing) this.computeLatestModValues();
		}
	}

	public goToNextBar(): void {
		if (!this.song) return;
		this.prevBar = this.bar;
		const oldBar: number = this.bar;
		this.bar++;
		if (this.bar >= this.song.barCount) {
			this.bar = 0;
		}
		this.playheadInternal += this.bar - oldBar;

		if (this.playing) this.computeLatestModValues();
	}

	public goToPrevBar(): void {
		if (!this.song) return;
		this.prevBar = null;
		const oldBar: number = this.bar;
		this.bar--;
		if (this.bar < 0 || this.bar >= this.song.barCount) {
			this.bar = this.song.barCount - 1;
		}
		this.playheadInternal += this.bar - oldBar;

		if (this.playing) this.computeLatestModValues();
	}

	private getNextBar(): number {
		let nextBar: number = this.bar + 1;
		if (this.isRecording) {
			if (nextBar >= this.song!.barCount) {
				nextBar = this.song!.barCount - 1;
			}
		} else if (this.loopRepeatCount != 0 && nextBar == this.song!.loopStart + this.song!.loopLength) {
			nextBar = this.song!.loopStart;
		}
		return nextBar;
	}

	public skipBar(): void {
		if (!this.song) return;
		const samplesPerTick: number = this.getSamplesPerTick();
		this.bar++;
		this.beat = 0;
		this.part = 0;
		this.tick = 0;
		this.tickSampleCountdown = samplesPerTick;
		this.isAtStartOfTick = true;

		if (this.loopRepeatCount != 0 && this.bar == this.song.loopStart + this.song.loopLength) {
			this.bar = this.song.loopStart;
			if (this.loopRepeatCount > 0) this.loopRepeatCount--;
		}
	}

	private audioProcessCallback = (audioProcessingEvent: any): void => {
		const outputBuffer = audioProcessingEvent.outputBuffer;
		const outputDataL: Float32Array = outputBuffer.getChannelData(0);
		const outputDataR: Float32Array = outputBuffer.getChannelData(1);

		if (
			this.browserAutomaticallyClearsAudioBuffer &&
			(outputDataL[0] != 0.0 ||
				outputDataR[0] != 0.0 ||
				outputDataL[outputBuffer.length - 1] != 0.0 ||
				outputDataR[outputBuffer.length - 1] != 0.0)
		) {
			// If the buffer is ever initially nonzero, then this must be an older browser that doesn't automatically clear the audio buffer.
			this.browserAutomaticallyClearsAudioBuffer = false;
		}
		if (!this.browserAutomaticallyClearsAudioBuffer) {
			// If this browser does not clear the buffer automatically, do so manually before continuing.
			const length: number = outputBuffer.length;
			for (let i: number = 0; i < length; i++) {
				outputDataL[i] = 0.0;
				outputDataR[i] = 0.0;
			}
		}

		if (!this.isPlayingSong && performance.now() >= this.liveInputEndTime) {
			this.deactivateAudio();
		} else {
			this.synthesize(outputDataL, outputDataR, outputBuffer.length, this.isPlayingSong);
		}
	};

	public synthesize(
		outputDataL: Float32Array,
		outputDataR: Float32Array,
		outputBufferLength: number,
		playSong: boolean = true
	): void {
		if (this.song == null) {
			for (let i: number = 0; i < outputBufferLength; i++) {
				outputDataL[i] = 0.0;
				outputDataR[i] = 0.0;
			}
			this.deactivateAudio();
			return;
		}

		const song: Song = this.song;
		this.song.inVolumeCap = 0.0; // Reset volume cap for this run
		this.song.outVolumeCap = 0.0;

		let samplesPerTick: number = this.getSamplesPerTick();
		let ended: boolean = false;

		// Check the bounds of the playhead:
		if (this.tickSampleCountdown <= 0 || this.tickSampleCountdown > samplesPerTick) {
			this.tickSampleCountdown = samplesPerTick;
			this.isAtStartOfTick = true;
		}
		if (playSong) {
			if (this.beat >= song.beatsPerBar) {
				this.beat = 0;
				this.part = 0;
				this.tick = 0;
				this.tickSampleCountdown = samplesPerTick;
				this.isAtStartOfTick = true;

				this.prevBar = this.bar;
				this.bar = this.getNextBar();
				if (this.bar <= this.prevBar && this.loopRepeatCount > 0) this.loopRepeatCount--;
			}
			if (this.bar >= song.barCount) {
				this.bar = 0;
				if (this.loopRepeatCount != -1) {
					ended = true;
					this.pause();
				}
			}
		}

		//const synthStartTime: number = performance.now();

		this.syncSongState();

		if (
			this.tempMonoInstrumentSampleBuffer == null ||
			this.tempMonoInstrumentSampleBuffer.length < outputBufferLength
		) {
			this.tempMonoInstrumentSampleBuffer = new Float32Array(outputBufferLength);
		}

		// Post processing parameters:
		const volume: number = +this.volume;
		const limitDecay: number = 1.0 - Math.pow(0.5, 4.0 / this.samplesPerSecond);
		const limitRise: number = 1.0 - Math.pow(0.5, 4000.0 / this.samplesPerSecond);
		let limit: number = +this.limit;
		let skippedBars: number[] = [];
		let firstSkippedBufferIndex: number = -1;

		let bufferIndex: number = 0;
		while (bufferIndex < outputBufferLength && !ended) {
			this.nextBar = this.getNextBar();
			if (this.nextBar >= song.barCount) this.nextBar = null;

			const samplesLeftInBuffer: number = outputBufferLength - bufferIndex;
			const samplesLeftInTick: number = Math.ceil(this.tickSampleCountdown);
			const runLength: number = Math.min(samplesLeftInTick, samplesLeftInBuffer);
			const runEnd: number = bufferIndex + runLength;

			// Handle mod synth
			if (this.isPlayingSong || this.renderingSong) {
				for (
					let channelIndex: number = song.pitchChannelCount + song.noiseChannelCount;
					channelIndex < song.getChannelCount();
					channelIndex++
				) {
					const channel: Channel = song.channels[channelIndex];
					const channelState: ChannelState = this.channels[channelIndex];

					this.determineCurrentActiveTones(song, channelIndex, samplesPerTick, playSong);

					for (
						let instrumentIndex: number = 0;
						instrumentIndex < channel.instruments.length;
						instrumentIndex++
					) {
						const instrumentState: InstrumentState = channelState.instruments[instrumentIndex];

						for (let i: number = 0; i < instrumentState.activeModTones.count(); i++) {
							const tone: Tone = instrumentState.activeModTones.get(i);
							this.playModTone(
								song,
								channelIndex,
								samplesPerTick,
								bufferIndex,
								runLength,
								tone,
								false,
								false
							);
						}
					}
				}
			}

			// Handle next bar mods if they were set
			if (this.wantToSkip) {
				// Unable to continue, as we have skipped back to a previously visited bar without generating new samples, which means we are infinitely skipping.
				// In this case processing will return before the designated number of samples are processed. In other words, silence will be generated.
				let barVisited: boolean = skippedBars.includes(this.bar);
				if (barVisited && bufferIndex == firstSkippedBufferIndex) return;
				if (firstSkippedBufferIndex == -1) {
					firstSkippedBufferIndex = bufferIndex;
				}
				if (!barVisited) skippedBars.push(this.bar);

				this.wantToSkip = false;
				this.skipBar();
				continue;
			}

			for (
				let channelIndex: number = 0;
				channelIndex < song.pitchChannelCount + song.noiseChannelCount;
				channelIndex++
			) {
				const channel: Channel = song.channels[channelIndex];
				const channelState: ChannelState = this.channels[channelIndex];

				if (this.isAtStartOfTick) {
					this.determineCurrentActiveTones(
						song,
						channelIndex,
						samplesPerTick,
						playSong && !this.countInMetronome
					);
					this.determineLiveInputTones(song, channelIndex, samplesPerTick);
				}
				for (let instrumentIndex: number = 0; instrumentIndex < channel.instruments.length; instrumentIndex++) {
					const instrument: Instrument = channel.instruments[instrumentIndex];
					const instrumentState: InstrumentState = channelState.instruments[instrumentIndex];

					if (this.isAtStartOfTick) {
						let tonesPlayedInThisInstrument: number =
							instrumentState.activeTones.count() + instrumentState.liveInputTones.count();

						for (let i: number = 0; i < instrumentState.releasedTones.count(); i++) {
							const tone: Tone = instrumentState.releasedTones.get(i);
							if (tone.ticksSinceReleased >= Math.abs(instrument.getFadeOutTicks())) {
								this.freeReleasedTone(instrumentState, i);
								i--;
								continue;
							}
							const shouldFadeOutFast: boolean =
								tonesPlayedInThisInstrument >= Config.maximumTonesPerChannel;
							this.computeTone(song, channelIndex, samplesPerTick, tone, true, shouldFadeOutFast);
							tonesPlayedInThisInstrument++;
						}

						if (instrumentState.awake) {
							if (!instrumentState.computed) {
								instrumentState.compute(
									this,
									instrument,
									samplesPerTick,
									Math.ceil(samplesPerTick),
									null,
									channelIndex,
									instrumentIndex
								);
							}

							instrumentState.computed = false;
							//instrumentState.envelopeComputer.clearEnvelopes();
						}
					}

					for (let i: number = 0; i < instrumentState.activeTones.count(); i++) {
						const tone: Tone = instrumentState.activeTones.get(i);
						this.playTone(channelIndex, bufferIndex, runLength, tone);
					}

					for (let i: number = 0; i < instrumentState.liveInputTones.count(); i++) {
						const tone: Tone = instrumentState.liveInputTones.get(i);
						this.playTone(channelIndex, bufferIndex, runLength, tone);
					}

					for (let i: number = 0; i < instrumentState.releasedTones.count(); i++) {
						const tone: Tone = instrumentState.releasedTones.get(i);
						this.playTone(channelIndex, bufferIndex, runLength, tone);
					}

					if (instrumentState.awake) {
						Synth.effectsSynth(this, outputDataL, outputDataR, bufferIndex, runLength, instrumentState);
					}

					// Update LFO time for instruments (used to be deterministic based on bar position but now vibrato/arp speed messes that up!)

					const tickSampleCountdown: number = this.tickSampleCountdown;
					const startRatio: number = 1.0 - tickSampleCountdown / samplesPerTick;
					const endRatio: number = 1.0 - (tickSampleCountdown - runLength) / samplesPerTick;
					const ticksIntoBar: number =
						(this.beat * Config.partsPerBeat + this.part) * Config.ticksPerPart + this.tick;
					const partTimeTickStart: number = ticksIntoBar / Config.ticksPerPart;
					const partTimeTickEnd: number = (ticksIntoBar + 1) / Config.ticksPerPart;
					const partTimeStart: number =
						partTimeTickStart + (partTimeTickEnd - partTimeTickStart) * startRatio;
					const partTimeEnd: number = partTimeTickStart + (partTimeTickEnd - partTimeTickStart) * endRatio;
					let useVibratoSpeed: number = instrument.vibratoSpeed;

					instrument.LFOtime = instrument.nextLFOtime;

					if (
						this.isModActive(
							Config.modulators.dictionary["vibrato speed"].index,
							channelIndex,
							instrumentIndex
						)
					) {
						useVibratoSpeed = this.getModValue(
							Config.modulators.dictionary["vibrato speed"].index,
							channelIndex,
							instrumentIndex
						);
					}

					if (useVibratoSpeed == 0) {
						instrument.LFOtime = 0;
						instrument.nextLFOtime = 0;
					} else {
						instrument.nextLFOtime += useVibratoSpeed * 0.1 * (partTimeEnd - partTimeStart);
					}
				}
			}

			if (this.enableMetronome || this.countInMetronome) {
				if (this.part == 0) {
					if (!this.startedMetronome) {
						const midBeat: boolean =
							song.beatsPerBar > 4 && song.beatsPerBar % 2 == 0 && this.beat == song.beatsPerBar / 2;
						const periods: number = this.beat == 0 ? 8 : midBeat ? 6 : 4;
						const hz: number = this.beat == 0 ? 1600 : midBeat ? 1200 : 800;
						const amplitude: number = this.beat == 0 ? 0.06 : midBeat ? 0.05 : 0.04;
						const samplesPerPeriod: number = this.samplesPerSecond / hz;
						const radiansPerSample: number = (Math.PI * 2.0) / samplesPerPeriod;
						this.metronomeSamplesRemaining = Math.floor(samplesPerPeriod * periods);
						this.metronomeFilter = 2.0 * Math.cos(radiansPerSample);
						this.metronomeAmplitude = amplitude * Math.sin(radiansPerSample);
						this.metronomePrevAmplitude = 0.0;

						this.startedMetronome = true;
					}
					if (this.metronomeSamplesRemaining > 0) {
						const stopIndex: number = Math.min(runEnd, bufferIndex + this.metronomeSamplesRemaining);
						this.metronomeSamplesRemaining -= stopIndex - bufferIndex;
						for (let i: number = bufferIndex; i < stopIndex; i++) {
							outputDataL[i] += this.metronomeAmplitude;
							outputDataR[i] += this.metronomeAmplitude;
							const tempAmplitude: number =
								this.metronomeFilter * this.metronomeAmplitude - this.metronomePrevAmplitude;
							this.metronomePrevAmplitude = this.metronomeAmplitude;
							this.metronomeAmplitude = tempAmplitude;
						}
					}
				} else {
					this.startedMetronome = false;
				}
			}

			// Post processing:
			for (let i: number = bufferIndex; i < runEnd; i++) {
				// A compressor/limiter.
				const sampleL = outputDataL[i] * song.masterGain * song.masterGain;
				const sampleR = outputDataR[i] * song.masterGain * song.masterGain;
				const absL: number = sampleL < 0.0 ? -sampleL : sampleL;
				const absR: number = sampleR < 0.0 ? -sampleR : sampleR;
				const abs: number = absL > absR ? absL : absR;
				this.song.inVolumeCap = this.song.inVolumeCap > abs ? this.song.inVolumeCap : abs; // Analytics, spit out raw input volume
				// Determines which formula to use. 0 when volume is between [0, compressionThreshold], 1 when between (compressionThreshold, limitThreshold], 2 above
				const limitRange: number = +(abs > song.compressionThreshold) + +(abs > song.limitThreshold);
				// Determine the target amplification based on the range of the curve
				const limitTarget: number =
					+(limitRange == 0) *
						(((abs + 1 - song.compressionThreshold) * 0.8 + 0.25) * song.compressionRatio +
							1.05 * (1 - song.compressionRatio)) +
					+(limitRange == 1) * 1.05 +
					+(limitRange == 2) *
						(1.05 * ((abs + 1 - song.limitThreshold) * song.limitRatio + (1 - song.limitThreshold)));
				// Move the limit towards the target
				limit += (limitTarget - limit) * (limit < limitTarget ? limitRise : limitDecay);
				const limitedVolume = volume / (limit >= 1 ? limit * 1.05 : limit * 0.8 + 0.25);
				outputDataL[i] = sampleL * limitedVolume;
				outputDataR[i] = sampleR * limitedVolume;

				this.song.outVolumeCap =
					this.song.outVolumeCap > abs * limitedVolume ? this.song.outVolumeCap : abs * limitedVolume; // Analytics, spit out limited output volume
			}

			bufferIndex += runLength;

			this.isAtStartOfTick = false;
			this.tickSampleCountdown -= runLength;
			if (this.tickSampleCountdown <= 0) {
				this.isAtStartOfTick = true;

				// Track how long tones have been released, and free them if there are too many.
				// Also reset awake InstrumentStates that didn't have any Tones during this tick.
				for (const channelState of this.channels) {
					for (const instrumentState of channelState.instruments) {
						for (let i: number = 0; i < instrumentState.releasedTones.count(); i++) {
							const tone: Tone = instrumentState.releasedTones.get(i);
							if (tone.isOnLastTick) {
								this.freeReleasedTone(instrumentState, i);
								i--;
							} else {
								tone.ticksSinceReleased++;
							}
						}
						if (instrumentState.deactivateAfterThisTick) {
							instrumentState.deactivate();
						}
						instrumentState.tonesAddedInThisTick = false;
					}
				}

				// Update arpeggio time, which is used to calculate arpeggio position
				for (
					let channel: number = 0;
					channel < this.song.pitchChannelCount + this.song.noiseChannelCount;
					channel++
				) {
					for (
						let instrumentIdx: number = 0;
						instrumentIdx < this.song.channels[channel].instruments.length;
						instrumentIdx++
					) {
						let instrument: Instrument = this.song.channels[channel].instruments[instrumentIdx];
						let useArpeggioSpeed: number = instrument.arpeggioSpeed;
						if (this.isModActive(Config.modulators.dictionary["arp speed"].index, channel, instrumentIdx)) {
							useArpeggioSpeed = this.getModValue(
								Config.modulators.dictionary["arp speed"].index,
								channel,
								instrumentIdx,
								false
							);
							if (Number.isInteger(useArpeggioSpeed)) {
								instrument.arpTime += Config.arpSpeedScale[useArpeggioSpeed];
							} else {
								// Linear interpolate arpeggio values
								instrument.arpTime +=
									(1 - (useArpeggioSpeed % 1)) * Config.arpSpeedScale[Math.floor(useArpeggioSpeed)] +
									(useArpeggioSpeed % 1) * Config.arpSpeedScale[Math.ceil(useArpeggioSpeed)];
							}
						} else {
							instrument.arpTime += Config.arpSpeedScale[useArpeggioSpeed];
						}
					}
				}

				// Update next-used filters after each run
				for (
					let channel: number = 0;
					channel < this.song.pitchChannelCount + this.song.noiseChannelCount;
					channel++
				) {
					for (
						let instrumentIdx: number = 0;
						instrumentIdx < this.song.channels[channel].instruments.length;
						instrumentIdx++
					) {
						let instrument: Instrument = this.song.channels[channel].instruments[instrumentIdx];
						if (instrument.tmpEqFilterEnd != null) {
							instrument.tmpEqFilterStart = instrument.tmpEqFilterEnd;
						} else {
							instrument.tmpEqFilterStart = instrument.eqFilter;
						}
						if (instrument.tmpNoteFilterEnd != null) {
							instrument.tmpNoteFilterStart = instrument.tmpNoteFilterEnd;
						} else {
							instrument.tmpNoteFilterStart = instrument.noteFilter;
						}
					}
				}

				this.tick++;
				this.tickSampleCountdown += samplesPerTick;
				if (this.tick == Config.ticksPerPart) {
					this.tick = 0;
					this.part++;
					this.liveInputDuration--;

					if (this.part == Config.partsPerBeat) {
						this.part = 0;

						if (playSong) {
							this.beat++;
							if (this.beat == song.beatsPerBar) {
								// bar changed, reset for next bar:
								this.beat = 0;

								if (this.countInMetronome) {
									this.countInMetronome = false;
								} else {
									this.prevBar = this.bar;
									this.bar = this.getNextBar();
									if (this.bar <= this.prevBar && this.loopRepeatCount > 0) this.loopRepeatCount--;

									if (this.bar >= song.barCount) {
										this.bar = 0;
										if (this.loopRepeatCount != -1) {
											ended = true;
											this.resetEffects();
											this.pause();
										}
									}
								}
							}
						}
					}
				}
			}

			// Update mod values so that next values copy to current values
			for (let setting: number = 0; setting < Config.modulators.length; setting++) {
				if (this.nextModValues != null && this.nextModValues[setting] != null)
					this.modValues[setting] = this.nextModValues[setting];
			}

			// Set samples per tick if song tempo mods changed it
			if (this.isModActive(Config.modulators.dictionary["tempo"].index)) {
				samplesPerTick = this.getSamplesPerTick();
				this.tickSampleCountdown = Math.min(this.tickSampleCountdown, samplesPerTick);
			}

			// Bound LFO times to be within their period (to keep values from getting large)
			// I figured this modulo math probably doesn't have to happen every LFO tick.
			for (let channel: number = 0; channel < this.song.pitchChannelCount; channel++) {
				for (let instrument of this.song.channels[channel].instruments) {
					instrument.nextLFOtime =
						instrument.nextLFOtime %
						(Config.vibratoTypes[instrument.vibratoType].period /
							((Config.ticksPerPart * samplesPerTick) / this.samplesPerSecond));
					instrument.arpTime = instrument.arpTime % (2520 * Config.ticksPerArpeggio); // 2520 = LCM of 4, 5, 6, 7, 8, 9 (arp sizes)
				}
			}

			for (let setting: number = 0; setting < Config.modulators.length; setting++) {
				for (
					let channel: number = 0;
					channel < this.song.pitchChannelCount + this.song.noiseChannelCount;
					channel++
				) {
					for (
						let instrument: number = 0;
						instrument < this.song.getMaxInstrumentsPerChannel();
						instrument++
					) {
						if (
							this.nextModInsValues != null &&
							this.nextModInsValues[channel] != null &&
							this.nextModInsValues[channel][instrument] != null &&
							this.nextModInsValues[channel][instrument][setting] != null
						) {
							this.modInsValues[channel][instrument][setting] =
								this.nextModInsValues[channel][instrument][setting];
						}
					}
				}
			}
		}

		// Optimization: Avoid persistent reverb values in the float denormal range.
		if (!Number.isFinite(limit) || Math.abs(limit) < epsilon) limit = 0.0;
		this.limit = limit;

		if (playSong && !this.countInMetronome) {
			this.playheadInternal =
				(((this.tick + 1.0 - this.tickSampleCountdown / samplesPerTick) / 2.0 + this.part) /
					Config.partsPerBeat +
					this.beat) /
					song.beatsPerBar +
				this.bar;
		}

		/*
        const synthDuration: number = performance.now() - synthStartTime;
        // Performance measurements:
        samplesAccumulated += outputBufferLength;
        samplePerformance += synthDuration;
    	
        if (samplesAccumulated >= 44100 * 4) {
            const secondsGenerated = samplesAccumulated / 44100;
            const secondsRequired = samplePerformance / 1000;
            const ratio = secondsRequired / secondsGenerated;
            console.log(ratio);
            samplePerformance = 0;
            samplesAccumulated = 0;
        }
        */
	}

	private freeTone(tone: Tone): void {
		this.tonePool.pushBack(tone);
	}

	private newTone(): Tone {
		if (this.tonePool.count() > 0) {
			const tone: Tone = this.tonePool.popBack();
			tone.freshlyAllocated = true;
			return tone;
		}
		return new Tone();
	}

	private releaseTone(instrumentState: InstrumentState, tone: Tone): void {
		instrumentState.releasedTones.pushFront(tone);
		tone.atNoteStart = false;
		tone.passedEndOfNote = true;
	}

	private freeReleasedTone(instrumentState: InstrumentState, toneIndex: number): void {
		this.freeTone(instrumentState.releasedTones.get(toneIndex));
		instrumentState.releasedTones.remove(toneIndex);
	}

	public freeAllTones(): void {
		for (const channelState of this.channels) {
			for (const instrumentState of channelState.instruments) {
				while (instrumentState.activeTones.count() > 0) this.freeTone(instrumentState.activeTones.popBack());
				while (instrumentState.activeModTones.count() > 0)
					this.freeTone(instrumentState.activeModTones.popBack());
				while (instrumentState.releasedTones.count() > 0)
					this.freeTone(instrumentState.releasedTones.popBack());
				while (instrumentState.liveInputTones.count() > 0)
					this.freeTone(instrumentState.liveInputTones.popBack());
			}
		}
	}

	private determineLiveInputTones(song: Song, channelIndex: number, samplesPerTick: number): void {
		const channel: Channel = song.channels[channelIndex];
		const channelState: ChannelState = this.channels[channelIndex];
		const pitches: number[] = this.liveInputPitches;

		for (let instrumentIndex: number = 0; instrumentIndex < channel.instruments.length; instrumentIndex++) {
			const instrumentState: InstrumentState = channelState.instruments[instrumentIndex];
			const toneList: Deque<Tone> = instrumentState.liveInputTones;
			let toneCount: number = 0;
			if (
				this.liveInputDuration > 0 &&
				channelIndex == this.liveInputChannel &&
				pitches.length > 0 &&
				this.liveInputInstruments.indexOf(instrumentIndex) != -1
			) {
				const instrument: Instrument = channel.instruments[instrumentIndex];

				if (instrument.getChord().singleTone) {
					let tone: Tone;
					if (toneList.count() <= toneCount) {
						tone = this.newTone();
						toneList.pushBack(tone);
					} else if (!instrument.getTransition().isSeamless && this.liveInputStarted) {
						this.releaseTone(instrumentState, toneList.get(toneCount));
						tone = this.newTone();
						toneList.set(toneCount, tone);
					} else {
						tone = toneList.get(toneCount);
					}
					toneCount++;

					for (let i: number = 0; i < pitches.length; i++) {
						tone.pitches[i] = pitches[i];
					}
					tone.pitchCount = pitches.length;
					tone.chordSize = 1;
					tone.instrumentIndex = instrumentIndex;
					tone.note = tone.prevNote = tone.nextNote = null;
					tone.atNoteStart = this.liveInputStarted;
					tone.forceContinueAtStart = false;
					tone.forceContinueAtEnd = false;
					this.computeTone(song, channelIndex, samplesPerTick, tone, false, false);
				} else {
					//const transition: Transition = instrument.getTransition();

					this.moveTonesIntoOrderedTempMatchedList(toneList, pitches);

					for (let i: number = 0; i < pitches.length; i++) {
						//const strumOffsetParts: number = i * instrument.getChord().strumParts;

						let tone: Tone;
						if (this.tempMatchedPitchTones[toneCount] != null) {
							tone = this.tempMatchedPitchTones[toneCount]!;
							this.tempMatchedPitchTones[toneCount] = null;
							if (tone.pitchCount != 1 || tone.pitches[0] != pitches[i]) {
								this.releaseTone(instrumentState, tone);
								tone = this.newTone();
							}
							toneList.pushBack(tone);
						} else {
							tone = this.newTone();
							toneList.pushBack(tone);
						}
						toneCount++;

						tone.pitches[0] = pitches[i];
						tone.pitchCount = 1;
						tone.chordSize = pitches.length;
						tone.instrumentIndex = instrumentIndex;
						tone.note = tone.prevNote = tone.nextNote = null;
						tone.atNoteStart = this.liveInputStarted;
						tone.forceContinueAtStart = false;
						tone.forceContinueAtEnd = false;
						this.computeTone(song, channelIndex, samplesPerTick, tone, false, false);
					}
				}
			}

			while (toneList.count() > toneCount) {
				this.releaseTone(instrumentState, toneList.popBack());
			}

			this.clearTempMatchedPitchTones(toneCount, instrumentState);
		}

		this.liveInputStarted = false;
	}

	// Returns the chord type of the instrument in the adjacent pattern if it is compatible for a
	// seamless transition across patterns, otherwise returns null.
	private adjacentPatternHasCompatibleInstrumentTransition(
		song: Song,
		channel: Channel,
		pattern: Pattern,
		otherPattern: Pattern,
		instrumentIndex: number,
		transition: Transition,
		chord: Chord,
		note: Note,
		otherNote: Note,
		forceContinue: boolean
	): Chord | null {
		if (song.patternInstruments && otherPattern.instruments.indexOf(instrumentIndex) == -1) {
			// The adjacent pattern does not contain the same instrument as the current pattern.

			if (pattern.instruments.length > 1 || otherPattern.instruments.length > 1) {
				// The current or adjacent pattern contains more than one instrument, don't bother
				// trying to connect them.
				return null;
			}
			// Otherwise, the two patterns each contain one instrument, but not the same instrument.
			// Try to connect them.
			const otherInstrument: Instrument = channel.instruments[otherPattern.instruments[0]];

			if (forceContinue) {
				// Even non-seamless instruments can be connected across patterns if forced.
				return otherInstrument.getChord();
			}

			// Otherwise, check that both instruments are seamless across patterns.
			const otherTransition: Transition = otherInstrument.getTransition();
			if (
				transition.includeAdjacentPatterns &&
				otherTransition.includeAdjacentPatterns &&
				otherTransition.slides == transition.slides
			) {
				return otherInstrument.getChord();
			} else {
				return null;
			}
		} else {
			// If both patterns contain the same instrument, check that it is seamless across patterns.
			return forceContinue || transition.includeAdjacentPatterns ? chord : null;
		}
	}

	public static adjacentNotesHaveMatchingPitches(firstNote: Note, secondNote: Note): boolean {
		if (firstNote.pitches.length != secondNote.pitches.length) return false;
		const firstNoteInterval: number = firstNote.pins[firstNote.pins.length - 1].interval;
		for (const pitch of firstNote.pitches) {
			if (secondNote.pitches.indexOf(pitch + firstNoteInterval) == -1) return false;
		}
		return true;
	}

	private moveTonesIntoOrderedTempMatchedList(toneList: Deque<Tone>, notePitches: number[]): void {
		// The tones are about to seamlessly transition to a new note. The pitches
		// from the old note may or may not match any of the pitches in the new
		// note, and not necessarily in order, but if any do match, they'll sound
		// better if those tones continue to have the same pitch. Attempt to find
		// the right spot for each old tone in the new chord if possible.

		for (let i: number = 0; i < toneList.count(); i++) {
			const tone: Tone = toneList.get(i);
			const pitch: number = tone.pitches[0] + tone.lastInterval;
			for (let j: number = 0; j < notePitches.length; j++) {
				if (notePitches[j] == pitch) {
					this.tempMatchedPitchTones[j] = tone;
					toneList.remove(i);
					i--;
					break;
				}
			}
		}

		// Any tones that didn't get matched should just fill in the gaps.
		while (toneList.count() > 0) {
			const tone: Tone = toneList.popFront();
			for (let j: number = 0; j < this.tempMatchedPitchTones.length; j++) {
				if (this.tempMatchedPitchTones[j] == null) {
					this.tempMatchedPitchTones[j] = tone;
					break;
				}
			}
		}
	}

	private determineCurrentActiveTones(
		song: Song,
		channelIndex: number,
		samplesPerTick: number,
		playSong: boolean
	): void {
		const channel: Channel = song.channels[channelIndex];
		const channelState: ChannelState = this.channels[channelIndex];
		const pattern: Pattern | null = song.getPattern(channelIndex, this.bar);
		const currentPart: number = this.getCurrentPart();
		const currentTick: number = this.tick + Config.ticksPerPart * currentPart;

		if (playSong && song.getChannelIsMod(channelIndex)) {
			// For mod channels, notes aren't strictly arranged chronologically. Also, each pitch value could play or not play at a given time. So... a bit more computation involved!
			// The same transition logic should apply though, even though it isn't really used by mod channels.
			let notes: (Note | null)[] = [];
			let prevNotes: (Note | null)[] = [];
			let nextNotes: (Note | null)[] = [];
			let fillCount: number = Config.modCount;
			while (fillCount--) {
				notes.push(null);
				prevNotes.push(null);
				nextNotes.push(null);
			}

			if (pattern != null && !channel.muted) {
				for (let i: number = 0; i < pattern.notes.length; i++) {
					if (pattern.notes[i].end <= currentPart) {
						// Actually need to check which note starts closer to the start of this note.
						if (
							prevNotes[pattern.notes[i].pitches[0]] == null ||
							pattern.notes[i].end > (prevNotes[pattern.notes[i].pitches[0]] as Note).start
						) {
							prevNotes[pattern.notes[i].pitches[0]] = pattern.notes[i];
						}
					} else if (pattern.notes[i].start <= currentPart && pattern.notes[i].end > currentPart) {
						notes[pattern.notes[i].pitches[0]] = pattern.notes[i];
					} else if (pattern.notes[i].start > currentPart) {
						// Actually need to check which note starts closer to the end of this note.
						if (
							nextNotes[pattern.notes[i].pitches[0]] == null ||
							pattern.notes[i].start < (nextNotes[pattern.notes[i].pitches[0]] as Note).start
						) {
							nextNotes[pattern.notes[i].pitches[0]] = pattern.notes[i];
						}
					}
				}
			}

			let modToneCount: number = 0;
			const newInstrumentIndex: number = song.patternInstruments && pattern != null ? pattern!.instruments[0] : 0;
			const instrumentState: InstrumentState = channelState.instruments[newInstrumentIndex];
			const toneList: Deque<Tone> = instrumentState.activeModTones;
			for (let mod: number = 0; mod < Config.modCount; mod++) {
				if (notes[mod] != null) {
					if (prevNotes[mod] != null && (prevNotes[mod] as Note).end != (notes[mod] as Note).start)
						prevNotes[mod] = null;
					if (nextNotes[mod] != null && (nextNotes[mod] as Note).start != (notes[mod] as Note).end)
						nextNotes[mod] = null;
				}

				if (
					channelState.singleSeamlessInstrument != null &&
					channelState.singleSeamlessInstrument != newInstrumentIndex &&
					channelState.singleSeamlessInstrument < channelState.instruments.length
				) {
					const sourceInstrumentState: InstrumentState =
						channelState.instruments[channelState.singleSeamlessInstrument];
					const destInstrumentState: InstrumentState = channelState.instruments[newInstrumentIndex];
					while (sourceInstrumentState.activeModTones.count() > 0) {
						destInstrumentState.activeModTones.pushFront(sourceInstrumentState.activeModTones.popBack());
					}
				}
				channelState.singleSeamlessInstrument = newInstrumentIndex;

				if (notes[mod] != null) {
					let prevNoteForThisInstrument: Note | null = prevNotes[mod];
					let nextNoteForThisInstrument: Note | null = nextNotes[mod];

					let forceContinueAtStart: boolean = false;
					let forceContinueAtEnd: boolean = false;
					const atNoteStart: boolean =
						Config.ticksPerPart * notes[mod]!.start == currentTick && this.isAtStartOfTick;
					let tone: Tone;
					if (toneList.count() <= modToneCount) {
						tone = this.newTone();
						toneList.pushBack(tone);
					} else if (atNoteStart && prevNoteForThisInstrument == null) {
						const oldTone: Tone = toneList.get(modToneCount);
						if (oldTone.isOnLastTick) {
							this.freeTone(oldTone);
						} else {
							this.releaseTone(instrumentState, oldTone);
						}
						tone = this.newTone();
						toneList.set(modToneCount, tone);
					} else {
						tone = toneList.get(modToneCount);
					}
					modToneCount++;

					for (let i: number = 0; i < notes[mod]!.pitches.length; i++) {
						tone.pitches[i] = notes[mod]!.pitches[i];
					}
					tone.pitchCount = notes[mod]!.pitches.length;
					tone.chordSize = 1;
					tone.instrumentIndex = newInstrumentIndex;
					tone.note = notes[mod];
					tone.noteStartPart = notes[mod]!.start;
					tone.noteEndPart = notes[mod]!.end;
					tone.prevNote = prevNoteForThisInstrument;
					tone.nextNote = nextNoteForThisInstrument;
					tone.prevNotePitchIndex = 0;
					tone.nextNotePitchIndex = 0;
					tone.atNoteStart = atNoteStart;
					tone.passedEndOfNote = false;
					tone.forceContinueAtStart = forceContinueAtStart;
					tone.forceContinueAtEnd = forceContinueAtEnd;
				}
			}
			// Automatically free or release seamless tones if there's no new note to take over.
			while (toneList.count() > modToneCount) {
				const tone: Tone = toneList.popBack();
				const channel: Channel = song.channels[channelIndex];
				if (tone.instrumentIndex < channel.instruments.length && !tone.isOnLastTick) {
					const instrumentState: InstrumentState =
						this.channels[channelIndex].instruments[tone.instrumentIndex];
					this.releaseTone(instrumentState, tone);
				} else {
					this.freeTone(tone);
				}
			}
		} else if (!song.getChannelIsMod(channelIndex)) {
			let note: Note | null = null;
			let prevNote: Note | null = null;
			let nextNote: Note | null = null;

			if (
				playSong &&
				pattern != null &&
				!channel.muted &&
				(!this.isRecording || this.liveInputChannel != channelIndex)
			) {
				for (let i: number = 0; i < pattern.notes.length; i++) {
					if (pattern.notes[i].end <= currentPart) {
						prevNote = pattern.notes[i];
					} else if (pattern.notes[i].start <= currentPart && pattern.notes[i].end > currentPart) {
						note = pattern.notes[i];
					} else if (pattern.notes[i].start > currentPart) {
						nextNote = pattern.notes[i];
						break;
					}
				}

				if (note != null) {
					if (prevNote != null && prevNote.end != note.start) prevNote = null;
					if (nextNote != null && nextNote.start != note.end) nextNote = null;
				}
			}

			// Seamless tones from a pattern with a single instrument can be transferred to a different single seamless instrument in the next pattern.
			if (
				pattern != null &&
				(!song.layeredInstruments ||
					channel.instruments.length == 1 ||
					(song.patternInstruments && pattern.instruments.length == 1))
			) {
				const newInstrumentIndex: number = song.patternInstruments ? pattern.instruments[0] : 0;
				if (
					channelState.singleSeamlessInstrument != null &&
					channelState.singleSeamlessInstrument != newInstrumentIndex &&
					channelState.singleSeamlessInstrument < channelState.instruments.length
				) {
					const sourceInstrumentState: InstrumentState =
						channelState.instruments[channelState.singleSeamlessInstrument];
					const destInstrumentState: InstrumentState = channelState.instruments[newInstrumentIndex];
					while (sourceInstrumentState.activeTones.count() > 0) {
						destInstrumentState.activeTones.pushFront(sourceInstrumentState.activeTones.popBack());
					}
				}
				channelState.singleSeamlessInstrument = newInstrumentIndex;
			} else {
				channelState.singleSeamlessInstrument = null;
			}

			for (let instrumentIndex: number = 0; instrumentIndex < channel.instruments.length; instrumentIndex++) {
				const instrumentState: InstrumentState = channelState.instruments[instrumentIndex];
				const toneList: Deque<Tone> = instrumentState.activeTones;
				let toneCount: number = 0;
				if (note != null && (!song.patternInstruments || pattern!.instruments.indexOf(instrumentIndex) != -1)) {
					const instrument: Instrument = channel.instruments[instrumentIndex];
					let prevNoteForThisInstrument: Note | null = prevNote;
					let nextNoteForThisInstrument: Note | null = nextNote;

					const partsPerBar: Number = Config.partsPerBeat * song.beatsPerBar;
					const transition: Transition = instrument.getTransition();
					const chord: Chord = instrument.getChord();
					let forceContinueAtStart: boolean = false;
					let forceContinueAtEnd: boolean = false;
					let tonesInPrevNote: number = 0;
					let tonesInNextNote: number = 0;
					if (note.start == 0) {
						// If the beginning of the note coincides with the beginning of the pattern,
						let prevPattern: Pattern | null =
							this.prevBar == null ? null : song.getPattern(channelIndex, this.prevBar);
						if (prevPattern != null) {
							const lastNote: Note | null =
								prevPattern.notes.length <= 0 ? null : prevPattern.notes[prevPattern.notes.length - 1];
							if (lastNote != null && lastNote.end == partsPerBar) {
								const patternForcesContinueAtStart: boolean =
									note.continuesLastPattern && Synth.adjacentNotesHaveMatchingPitches(lastNote, note);
								const chordOfCompatibleInstrument: Chord | null =
									this.adjacentPatternHasCompatibleInstrumentTransition(
										song,
										channel,
										pattern!,
										prevPattern,
										instrumentIndex,
										transition,
										chord,
										note,
										lastNote,
										patternForcesContinueAtStart
									);
								if (chordOfCompatibleInstrument != null) {
									prevNoteForThisInstrument = lastNote;
									tonesInPrevNote = chordOfCompatibleInstrument.singleTone
										? 1
										: prevNoteForThisInstrument.pitches.length;
									forceContinueAtStart = patternForcesContinueAtStart;
								}
							}
						}
					} else if (prevNoteForThisInstrument != null) {
						tonesInPrevNote = chord.singleTone ? 1 : prevNoteForThisInstrument.pitches.length;
					}
					if (note.end == partsPerBar) {
						// If the end of the note coincides with the end of the pattern, look for an
						// adjacent note at the beginning of the next pattern.
						let nextPattern: Pattern | null =
							this.nextBar == null ? null : song.getPattern(channelIndex, this.nextBar);
						if (nextPattern != null) {
							const firstNote: Note | null = nextPattern.notes.length <= 0 ? null : nextPattern.notes[0];
							if (firstNote != null && firstNote.start == 0) {
								const nextPatternForcesContinueAtStart: boolean =
									firstNote.continuesLastPattern &&
									Synth.adjacentNotesHaveMatchingPitches(note, firstNote);
								const chordOfCompatibleInstrument: Chord | null =
									this.adjacentPatternHasCompatibleInstrumentTransition(
										song,
										channel,
										pattern!,
										nextPattern,
										instrumentIndex,
										transition,
										chord,
										note,
										firstNote,
										nextPatternForcesContinueAtStart
									);
								if (chordOfCompatibleInstrument != null) {
									nextNoteForThisInstrument = firstNote;
									tonesInNextNote = chordOfCompatibleInstrument.singleTone
										? 1
										: nextNoteForThisInstrument.pitches.length;
									forceContinueAtEnd = nextPatternForcesContinueAtStart;
								}
							}
						}
					} else if (nextNoteForThisInstrument != null) {
						tonesInNextNote = chord.singleTone ? 1 : nextNoteForThisInstrument.pitches.length;
					}

					if (chord.singleTone) {
						const atNoteStart: boolean = Config.ticksPerPart * note.start == currentTick;
						let tone: Tone;
						if (toneList.count() <= toneCount) {
							tone = this.newTone();
							toneList.pushBack(tone);
						} else if (
							atNoteStart &&
							((!(transition.isSeamless || instrument.clicklessTransition) && !forceContinueAtStart) ||
								prevNoteForThisInstrument == null)
						) {
							const oldTone: Tone = toneList.get(toneCount);
							if (oldTone.isOnLastTick) {
								this.freeTone(oldTone);
							} else {
								this.releaseTone(instrumentState, oldTone);
							}
							tone = this.newTone();
							toneList.set(toneCount, tone);
						} else {
							tone = toneList.get(toneCount);
						}
						toneCount++;

						for (let i: number = 0; i < note.pitches.length; i++) {
							tone.pitches[i] = note.pitches[i];
						}
						tone.pitchCount = note.pitches.length;
						tone.chordSize = 1;
						tone.instrumentIndex = instrumentIndex;
						tone.note = note;
						tone.noteStartPart = note.start;
						tone.noteEndPart = note.end;
						tone.prevNote = prevNoteForThisInstrument;
						tone.nextNote = nextNoteForThisInstrument;
						tone.prevNotePitchIndex = 0;
						tone.nextNotePitchIndex = 0;
						tone.atNoteStart = atNoteStart;
						tone.passedEndOfNote = false;
						tone.forceContinueAtStart = forceContinueAtStart;
						tone.forceContinueAtEnd = forceContinueAtEnd;
						this.computeTone(song, channelIndex, samplesPerTick, tone, false, false);
					} else {
						const transition: Transition = instrument.getTransition();

						if (
							((transition.isSeamless && !transition.slides && chord.strumParts == 0) ||
								forceContinueAtStart) &&
							Config.ticksPerPart * note.start == currentTick &&
							prevNoteForThisInstrument != null
						) {
							this.moveTonesIntoOrderedTempMatchedList(toneList, note.pitches);
						}

						let strumOffsetParts: number = 0;
						for (let i: number = 0; i < note.pitches.length; i++) {
							let prevNoteForThisTone: Note | null =
								tonesInPrevNote > i ? prevNoteForThisInstrument : null;
							let noteForThisTone: Note = note;
							let nextNoteForThisTone: Note | null =
								tonesInNextNote > i ? nextNoteForThisInstrument : null;
							let noteStartPart: number = noteForThisTone.start + strumOffsetParts;
							let passedEndOfNote: boolean = false;

							// Strumming may mean that a note's actual start time may be after the
							// note's displayed start time. If the note start hasn't been reached yet,
							// carry over the previous tone if available and seamless, otherwise skip
							// the new tone until it is ready to start.
							if (noteStartPart > currentPart) {
								if (
									toneList.count() > i &&
									(transition.isSeamless || forceContinueAtStart) &&
									prevNoteForThisTone != null
								) {
									// Continue the previous note's chord until the current one takes over.
									nextNoteForThisTone = noteForThisTone;
									noteForThisTone = prevNoteForThisTone;
									prevNoteForThisTone = null;
									noteStartPart = noteForThisTone.start + strumOffsetParts;
									passedEndOfNote = true;
								} else {
									// This and the rest of the tones in the chord shouldn't start yet.
									break;
								}
							}

							let noteEndPart: number = noteForThisTone.end;
							if ((transition.isSeamless || forceContinueAtStart) && nextNoteForThisTone != null) {
								noteEndPart = Math.min(
									Config.partsPerBeat * this.song!.beatsPerBar,
									noteEndPart + strumOffsetParts
								);
							}
							if ((!transition.continues && !forceContinueAtStart) || prevNoteForThisTone == null) {
								strumOffsetParts += chord.strumParts;
							}

							const atNoteStart: boolean = Config.ticksPerPart * noteStartPart == currentTick;
							let tone: Tone;
							if (this.tempMatchedPitchTones[toneCount] != null) {
								tone = this.tempMatchedPitchTones[toneCount]!;
								this.tempMatchedPitchTones[toneCount] = null;
								toneList.pushBack(tone);
							} else if (toneList.count() <= toneCount) {
								tone = this.newTone();
								toneList.pushBack(tone);
							} else if (
								atNoteStart &&
								((!transition.isSeamless && !forceContinueAtStart) || prevNoteForThisTone == null)
							) {
								const oldTone: Tone = toneList.get(toneCount);
								if (oldTone.isOnLastTick) {
									this.freeTone(oldTone);
								} else {
									this.releaseTone(instrumentState, oldTone);
								}
								tone = this.newTone();
								toneList.set(toneCount, tone);
							} else {
								tone = toneList.get(toneCount);
							}
							toneCount++;

							tone.pitches[0] = noteForThisTone.pitches[i];
							tone.pitchCount = 1;
							tone.chordSize = noteForThisTone.pitches.length;
							tone.instrumentIndex = instrumentIndex;
							tone.note = noteForThisTone;
							tone.noteStartPart = noteStartPart;
							tone.noteEndPart = noteEndPart;
							tone.prevNote = prevNoteForThisTone;
							tone.nextNote = nextNoteForThisTone;
							tone.prevNotePitchIndex = i;
							tone.nextNotePitchIndex = i;
							tone.atNoteStart = atNoteStart;
							tone.passedEndOfNote = passedEndOfNote;
							tone.forceContinueAtStart = forceContinueAtStart && prevNoteForThisTone != null;
							tone.forceContinueAtEnd = forceContinueAtEnd && nextNoteForThisTone != null;
							this.computeTone(song, channelIndex, samplesPerTick, tone, false, false);
						}
					}
				}
				// Automatically free or release seamless tones if there's no new note to take over.
				while (toneList.count() > toneCount) {
					const tone: Tone = toneList.popBack();
					const channel: Channel = song.channels[channelIndex];
					if (tone.instrumentIndex < channel.instruments.length && !tone.isOnLastTick) {
						const instrumentState: InstrumentState = channelState.instruments[tone.instrumentIndex];
						this.releaseTone(instrumentState, tone);
					} else {
						this.freeTone(tone);
					}
				}

				this.clearTempMatchedPitchTones(toneCount, instrumentState);
			}
		}
	}

	private clearTempMatchedPitchTones(toneCount: number, instrumentState: InstrumentState): void {
		for (let i: number = toneCount; i < this.tempMatchedPitchTones.length; i++) {
			const oldTone: Tone | null = this.tempMatchedPitchTones[i];
			if (oldTone != null) {
				if (oldTone.isOnLastTick) {
					this.freeTone(oldTone);
				} else {
					this.releaseTone(instrumentState, oldTone);
				}
				this.tempMatchedPitchTones[i] = null;
			}
		}
	}

	private playTone(channelIndex: number, bufferIndex: number, runLength: number, tone: Tone): void {
		const channelState: ChannelState = this.channels[channelIndex];
		const instrumentState: InstrumentState = channelState.instruments[tone.instrumentIndex];

		if (instrumentState.synthesizer != null)
			instrumentState.synthesizer!(this, bufferIndex, runLength, tone, instrumentState);
		tone.envelopeComputer.clearEnvelopes();
	}

	// Computes mod note position at the start and end of the window and "plays" the mod tone, setting appropriate mod data.
	private playModTone(
		song: Song,
		channelIndex: number,
		samplesPerTick: number,
		bufferIndex: number,
		roundedSamplesPerTick: number,
		tone: Tone,
		released: boolean,
		shouldFadeOutFast: boolean
	): void {
		const channel: Channel = song.channels[channelIndex];
		const instrument: Instrument = channel.instruments[tone.instrumentIndex];

		if (tone.note != null) {
			const ticksIntoBar: number = this.getTicksIntoBar();
			const partTimeTickStart: number = ticksIntoBar / Config.ticksPerPart;
			const partTimeTickEnd: number = (ticksIntoBar + 1) / Config.ticksPerPart;
			const tickSampleCountdown: number = this.tickSampleCountdown;
			const startRatio: number = 1.0 - tickSampleCountdown / samplesPerTick;
			const endRatio: number = 1.0 - (tickSampleCountdown - roundedSamplesPerTick) / samplesPerTick;
			const partTimeStart: number = partTimeTickStart + (partTimeTickEnd - partTimeTickStart) * startRatio;
			const partTimeEnd: number = partTimeTickStart + (partTimeTickEnd - partTimeTickStart) * endRatio;
			const tickTimeStart: number = Config.ticksPerPart * partTimeStart;
			const tickTimeEnd: number = Config.ticksPerPart * partTimeEnd;
			const endPinIndex: number = tone.note.getEndPinIndex(this.getCurrentPart());
			const startPin: NotePin = tone.note.pins[endPinIndex - 1];
			const endPin: NotePin = tone.note.pins[endPinIndex];
			const startPinTick: number = (tone.note.start + startPin.time) * Config.ticksPerPart;
			const endPinTick: number = (tone.note.start + endPin.time) * Config.ticksPerPart;
			const ratioStart: number = (tickTimeStart - startPinTick) / (endPinTick - startPinTick);
			const ratioEnd: number = (tickTimeEnd - startPinTick) / (endPinTick - startPinTick);
			tone.expression = startPin.size + (endPin.size - startPin.size) * ratioStart;
			tone.expressionDelta = startPin.size + (endPin.size - startPin.size) * ratioEnd - tone.expression;

			Synth.modSynth(this, bufferIndex, roundedSamplesPerTick, tone, instrument);
		}
	}

	private static computeChordExpression(chordSize: number): number {
		return 1.0 / ((chordSize - 1) * 0.25 + 1.0);
	}

	private computeTone(
		song: Song,
		channelIndex: number,
		samplesPerTick: number,
		tone: Tone,
		released: boolean,
		shouldFadeOutFast: boolean
	): void {
		const roundedSamplesPerTick: number = Math.ceil(samplesPerTick);
		const channel: Channel = song.channels[channelIndex];
		const channelState: ChannelState = this.channels[channelIndex];
		const instrument: Instrument = channel.instruments[tone.instrumentIndex];
		const instrumentState: InstrumentState = channelState.instruments[tone.instrumentIndex];
		instrumentState.awake = true;
		instrumentState.tonesAddedInThisTick = true;
		if (!instrumentState.computed) {
			instrumentState.compute(
				this,
				instrument,
				samplesPerTick,
				roundedSamplesPerTick,
				tone,
				channelIndex,
				tone.instrumentIndex
			);
		}
		const transition: Transition = instrument.getTransition();
		const chord: Chord = instrument.getChord();
		const chordExpression: number = chord.singleTone ? 1.0 : Synth.computeChordExpression(tone.chordSize);
		const isNoiseChannel: boolean = song.getChannelIsNoise(channelIndex);
		const intervalScale: number = isNoiseChannel ? Config.noiseInterval : 1;
		const secondsPerPart: number = (Config.ticksPerPart * samplesPerTick) / this.samplesPerSecond;
		const sampleTime: number = 1.0 / this.samplesPerSecond;
		const beatsPerPart: number = 1.0 / Config.partsPerBeat;
		const ticksIntoBar: number = this.getTicksIntoBar();
		const partTimeStart: number = ticksIntoBar / Config.ticksPerPart;
		const partTimeEnd: number = (ticksIntoBar + 1.0) / Config.ticksPerPart;
		const currentPart: number = this.getCurrentPart();

		let specialIntervalMult: number = 1.0;
		tone.specialIntervalExpressionMult = 1.0;

		//if (synth.isModActive(ModSetting.mstPan, channelIndex, tone.instrumentIndex)) {
		//    startPan = synth.getModValue(ModSetting.mstPan, false, channel, instrumentIdx, false);
		//    endPan = synth.getModValue(ModSetting.mstPan, false, channel, instrumentIdx, true);
		//}

		let toneIsOnLastTick: boolean = shouldFadeOutFast;
		let intervalStart: number = 0.0;
		let intervalEnd: number = 0.0;
		let fadeExpressionStart: number = 1.0;
		let fadeExpressionEnd: number = 1.0;
		let chordExpressionStart: number = chordExpression;
		let chordExpressionEnd: number = chordExpression;

		let expressionReferencePitch: number = 16; // A low "E" as a MIDI pitch.
		let basePitch: number = Config.keys[song.key].basePitch;
		let baseExpression: number = 1.0;
		let pitchDamping: number = 48;
		if (instrument.type == InstrumentType.spectrum) {
			baseExpression = Config.spectrumBaseExpression;
			if (isNoiseChannel) {
				basePitch = Config.spectrumBasePitch;
				baseExpression *= 2.0; // Note: spectrum is louder for drum channels than pitch channels!
			}
			expressionReferencePitch = Config.spectrumBasePitch;
			pitchDamping = 28;
		} else if (instrument.type == InstrumentType.drumset) {
			basePitch = Config.spectrumBasePitch;
			baseExpression = Config.drumsetBaseExpression;
			expressionReferencePitch = basePitch;
		} else if (instrument.type == InstrumentType.noise) {
			basePitch = Config.chipNoises[instrument.chipNoise].basePitch;
			baseExpression = Config.noiseBaseExpression;
			expressionReferencePitch = basePitch;
			pitchDamping = Config.chipNoises[instrument.chipNoise].isSoft ? 24.0 : 60.0;
		} else if (instrument.type == InstrumentType.fm) {
			baseExpression = Config.fmBaseExpression;
		} else if (instrument.type == InstrumentType.chip || instrument.type == InstrumentType.customChipWave) {
			baseExpression = Config.chipBaseExpression;
		} else if (instrument.type == InstrumentType.harmonics) {
			baseExpression = Config.harmonicsBaseExpression;
		} else if (instrument.type == InstrumentType.pwm) {
			baseExpression = Config.pwmBaseExpression;
		} else if (instrument.type == InstrumentType.pickedString) {
			baseExpression = Config.pickedStringBaseExpression;
		} else if (instrument.type == InstrumentType.mod) {
			baseExpression = 1.0;
			expressionReferencePitch = 0;
			pitchDamping = 1.0;
			basePitch = 0;
		} else {
			throw new Error("Unknown instrument type in computeTone.");
		}

		if ((tone.atNoteStart && !transition.isSeamless && !tone.forceContinueAtStart) || tone.freshlyAllocated) {
			tone.reset();
		}
		tone.freshlyAllocated = false;

		for (let i: number = 0; i < Config.maxPitchOrOperatorCount; i++) {
			tone.phaseDeltas[i] = 0.0;
			tone.phaseDeltaScales[i] = 0.0;
			tone.operatorExpressions[i] = 0.0;
			tone.operatorExpressionDeltas[i] = 0.0;
		}
		tone.expression = 0.0;
		tone.expressionDelta = 0.0;
		for (let i: number = 0; i < Config.operatorCount; i++) {
			tone.operatorWaves[i] = Synth.getOperatorWave(
				instrument.operators[i].waveform,
				instrument.operators[i].pulseWidth
			);
		}

		if (released) {
			const startTicksSinceReleased: number = tone.ticksSinceReleased;
			const endTicksSinceReleased: number = tone.ticksSinceReleased + 1.0;
			intervalStart = intervalEnd = tone.lastInterval;
			const fadeOutTicks: number = Math.abs(instrument.getFadeOutTicks());
			fadeExpressionStart = Synth.noteSizeToVolumeMult(
				(1.0 - startTicksSinceReleased / fadeOutTicks) * Config.noteSizeMax
			);
			fadeExpressionEnd = Synth.noteSizeToVolumeMult(
				(1.0 - endTicksSinceReleased / fadeOutTicks) * Config.noteSizeMax
			);

			if (shouldFadeOutFast) {
				fadeExpressionEnd = 0.0;
			}

			if (tone.ticksSinceReleased + 1 >= fadeOutTicks) toneIsOnLastTick = true;
		} else if (tone.note == null) {
			fadeExpressionStart = fadeExpressionEnd = 1.0;
			tone.lastInterval = 0;
			tone.ticksSinceReleased = 0;
			tone.liveInputSamplesHeld += roundedSamplesPerTick;
		} else {
			const note: Note = tone.note;
			const nextNote: Note | null = tone.nextNote;

			const noteStartPart: number = tone.noteStartPart;
			const noteEndPart: number = tone.noteEndPart;

			const endPinIndex: number = note.getEndPinIndex(currentPart);
			const startPin: NotePin = note.pins[endPinIndex - 1];
			const endPin: NotePin = note.pins[endPinIndex];
			const noteStartTick: number = noteStartPart * Config.ticksPerPart;
			const noteEndTick: number = noteEndPart * Config.ticksPerPart;
			const pinStart: number = (note.start + startPin.time) * Config.ticksPerPart;
			const pinEnd: number = (note.start + endPin.time) * Config.ticksPerPart;

			tone.ticksSinceReleased = 0;

			const tickTimeStart: number = currentPart * Config.ticksPerPart + this.tick;
			const tickTimeEnd: number = tickTimeStart + 1.0;
			const noteTicksPassedTickStart: number = tickTimeStart - noteStartTick;
			const noteTicksPassedTickEnd: number = tickTimeEnd - noteStartTick;
			const pinRatioStart: number = Math.min(1.0, (tickTimeStart - pinStart) / (pinEnd - pinStart));
			const pinRatioEnd: number = Math.min(1.0, (tickTimeEnd - pinStart) / (pinEnd - pinStart));
			fadeExpressionStart = 1.0;
			fadeExpressionEnd = 1.0;
			intervalStart = startPin.interval + (endPin.interval - startPin.interval) * pinRatioStart;
			intervalEnd = startPin.interval + (endPin.interval - startPin.interval) * pinRatioEnd;
			tone.lastInterval = intervalEnd;

			if ((!transition.isSeamless && !tone.forceContinueAtEnd) || nextNote == null) {
				const fadeOutTicks: number = -instrument.getFadeOutTicks();
				if (fadeOutTicks > 0.0) {
					// If the tone should fade out before the end of the note, do so here.
					const noteLengthTicks: number = noteEndTick - noteStartTick;
					fadeExpressionStart *= Math.min(1.0, (noteLengthTicks - noteTicksPassedTickStart) / fadeOutTicks);
					fadeExpressionEnd *= Math.min(1.0, (noteLengthTicks - noteTicksPassedTickEnd) / fadeOutTicks);
					if (tickTimeEnd >= noteStartTick + noteLengthTicks) toneIsOnLastTick = true;
				}
			}
		}

		tone.isOnLastTick = toneIsOnLastTick;

		let tmpNoteFilter: FilterSettings = instrument.noteFilter;
		let startPoint: FilterControlPoint;
		let endPoint: FilterControlPoint;

		if (instrument.noteFilterType) {
			// Simple EQ filter (old style). For analysis, using random filters from normal style since they are N/A in this context.
			const noteFilterSettingsStart: FilterSettings = instrument.noteFilter;
			if (instrument.noteSubFilters[1] == null) instrument.noteSubFilters[1] = new FilterSettings();
			const noteFilterSettingsEnd: FilterSettings = instrument.noteSubFilters[1];

			// Change location based on slider values
			let startSimpleFreq: number = instrument.noteFilterSimpleCut;
			let startSimpleGain: number = instrument.noteFilterSimplePeak;
			let endSimpleFreq: number = instrument.noteFilterSimpleCut;
			let endSimpleGain: number = instrument.noteFilterSimplePeak;
			let filterChanges: boolean = false;

			if (
				this.isModActive(
					Config.modulators.dictionary["note filt cut"].index,
					channelIndex,
					tone.instrumentIndex
				)
			) {
				startSimpleFreq = this.getModValue(
					Config.modulators.dictionary["note filt cut"].index,
					channelIndex,
					tone.instrumentIndex,
					false
				);
				endSimpleFreq = this.getModValue(
					Config.modulators.dictionary["note filt cut"].index,
					channelIndex,
					tone.instrumentIndex,
					true
				);
				filterChanges = true;
			}
			if (
				this.isModActive(
					Config.modulators.dictionary["note filt peak"].index,
					channelIndex,
					tone.instrumentIndex
				)
			) {
				startSimpleGain = this.getModValue(
					Config.modulators.dictionary["note filt peak"].index,
					channelIndex,
					tone.instrumentIndex,
					false
				);
				endSimpleGain = this.getModValue(
					Config.modulators.dictionary["note filt peak"].index,
					channelIndex,
					tone.instrumentIndex,
					true
				);
				filterChanges = true;
			}

			noteFilterSettingsStart.convertLegacySettingsForSynth(startSimpleFreq, startSimpleGain, !filterChanges);
			noteFilterSettingsEnd.convertLegacySettingsForSynth(endSimpleFreq, endSimpleGain, !filterChanges);

			startPoint = noteFilterSettingsStart.controlPoints[0];
			endPoint = noteFilterSettingsEnd.controlPoints[0];

			// Temporarily override so that envelope computer uses appropriate computed note filter
			instrument.noteFilter = noteFilterSettingsStart;
			instrument.tmpNoteFilterStart = noteFilterSettingsStart;
		}

		// Compute envelopes *after* resetting the tone, otherwise the envelope computer gets reset too!
		const envelopeComputer: EnvelopeComputer = tone.envelopeComputer;
		envelopeComputer.computeEnvelopes(
			instrument,
			currentPart,
			Config.ticksPerPart * partTimeStart,
			samplesPerTick / this.samplesPerSecond,
			tone
		);
		const envelopeStarts: number[] = tone.envelopeComputer.envelopeStarts;
		const envelopeEnds: number[] = tone.envelopeComputer.envelopeEnds;
		instrument.noteFilter = tmpNoteFilter;

		if (tone.note != null && transition.slides) {
			// Slide interval and chordExpression at the start and/or end of the note if necessary.
			const prevNote: Note | null = tone.prevNote;
			const nextNote: Note | null = tone.nextNote;
			if (prevNote != null) {
				const intervalDiff: number =
					prevNote.pitches[tone.prevNotePitchIndex] +
					prevNote.pins[prevNote.pins.length - 1].interval -
					tone.pitches[0];
				if (envelopeComputer.prevSlideStart)
					intervalStart += intervalDiff * envelopeComputer.prevSlideRatioStart;
				if (envelopeComputer.prevSlideEnd) intervalEnd += intervalDiff * envelopeComputer.prevSlideRatioEnd;
				if (!chord.singleTone) {
					const chordSizeDiff: number = prevNote.pitches.length - tone.chordSize;
					if (envelopeComputer.prevSlideStart)
						chordExpressionStart = Synth.computeChordExpression(
							tone.chordSize + chordSizeDiff * envelopeComputer.prevSlideRatioStart
						);
					if (envelopeComputer.prevSlideEnd)
						chordExpressionEnd = Synth.computeChordExpression(
							tone.chordSize + chordSizeDiff * envelopeComputer.prevSlideRatioEnd
						);
				}
			}
			if (nextNote != null) {
				const intervalDiff: number =
					nextNote.pitches[tone.nextNotePitchIndex] -
					(tone.pitches[0] + tone.note.pins[tone.note.pins.length - 1].interval);
				if (envelopeComputer.nextSlideStart)
					intervalStart += intervalDiff * envelopeComputer.nextSlideRatioStart;
				if (envelopeComputer.nextSlideEnd) intervalEnd += intervalDiff * envelopeComputer.nextSlideRatioEnd;
				if (!chord.singleTone) {
					const chordSizeDiff: number = nextNote.pitches.length - tone.chordSize;
					if (envelopeComputer.nextSlideStart)
						chordExpressionStart = Synth.computeChordExpression(
							tone.chordSize + chordSizeDiff * envelopeComputer.nextSlideRatioStart
						);
					if (envelopeComputer.nextSlideEnd)
						chordExpressionEnd = Synth.computeChordExpression(
							tone.chordSize + chordSizeDiff * envelopeComputer.nextSlideRatioEnd
						);
				}
			}
		}

		if (effectsIncludePitchShift(instrument.effects)) {
			let pitchShift: number = Config.justIntonationSemitones[instrument.pitchShift] / intervalScale;
			let pitchShiftScalarStart: number = 1.0;
			let pitchShiftScalarEnd: number = 1.0;
			if (
				this.isModActive(Config.modulators.dictionary["pitch shift"].index, channelIndex, tone.instrumentIndex)
			) {
				pitchShift = Config.justIntonationSemitones[Config.justIntonationSemitones.length - 1];
				pitchShiftScalarStart =
					this.getModValue(
						Config.modulators.dictionary["pitch shift"].index,
						channelIndex,
						tone.instrumentIndex,
						false
					) / Config.pitchShiftCenter;
				pitchShiftScalarEnd =
					this.getModValue(
						Config.modulators.dictionary["pitch shift"].index,
						channelIndex,
						tone.instrumentIndex,
						true
					) / Config.pitchShiftCenter;
			}
			const envelopeStart: number = envelopeStarts[EnvelopeComputeIndex.pitchShift];
			const envelopeEnd: number = envelopeEnds[EnvelopeComputeIndex.pitchShift];
			intervalStart += pitchShift * envelopeStart * pitchShiftScalarStart;
			intervalEnd += pitchShift * envelopeEnd * pitchShiftScalarEnd;
		}
		if (
			effectsIncludeDetune(instrument.effects) ||
			this.isModActive(Config.modulators.dictionary["song detune"].index, channelIndex, tone.instrumentIndex)
		) {
			const envelopeStart: number = envelopeStarts[EnvelopeComputeIndex.detune];
			const envelopeEnd: number = envelopeEnds[EnvelopeComputeIndex.detune];
			let modDetuneStart: number = instrument.detune;
			let modDetuneEnd: number = instrument.detune;
			if (this.isModActive(Config.modulators.dictionary["detune"].index, channelIndex, tone.instrumentIndex)) {
				modDetuneStart =
					this.getModValue(
						Config.modulators.dictionary["detune"].index,
						channelIndex,
						tone.instrumentIndex,
						false
					) + Config.detuneCenter;
				modDetuneEnd =
					this.getModValue(
						Config.modulators.dictionary["detune"].index,
						channelIndex,
						tone.instrumentIndex,
						true
					) + Config.detuneCenter;
			}
			if (
				this.isModActive(Config.modulators.dictionary["song detune"].index, channelIndex, tone.instrumentIndex)
			) {
				modDetuneStart +=
					4 *
					this.getModValue(
						Config.modulators.dictionary["song detune"].index,
						channelIndex,
						tone.instrumentIndex,
						false
					);
				modDetuneEnd +=
					4 *
					this.getModValue(
						Config.modulators.dictionary["song detune"].index,
						channelIndex,
						tone.instrumentIndex,
						true
					);
			}
			intervalStart +=
				(Synth.detuneToCents(modDetuneStart * envelopeStart) * Config.pitchesPerOctave) / (12.0 * 100.0);
			intervalEnd += (Synth.detuneToCents(modDetuneEnd * envelopeEnd) * Config.pitchesPerOctave) / (12.0 * 100.0);
		}

		if (effectsIncludeVibrato(instrument.effects)) {
			let delayTicks: number;
			let vibratoAmplitudeStart: number;
			let vibratoAmplitudeEnd: number;
			// Custom vibrato
			if (instrument.vibrato == Config.vibratos.length) {
				delayTicks = instrument.vibratoDelay * 2; // Delay was changed from parts to ticks in BB v9
				// Special case: if vibrato delay is max, NEVER vibrato.
				if (instrument.vibratoDelay == Config.modulators.dictionary["vibrato delay"].maxRawVol)
					delayTicks = Number.POSITIVE_INFINITY;
				vibratoAmplitudeStart = instrument.vibratoDepth;
				vibratoAmplitudeEnd = vibratoAmplitudeStart;
			} else {
				delayTicks = Config.vibratos[instrument.vibrato].delayTicks;
				vibratoAmplitudeStart = Config.vibratos[instrument.vibrato].amplitude;
				vibratoAmplitudeEnd = vibratoAmplitudeStart;
			}

			if (
				this.isModActive(
					Config.modulators.dictionary["vibrato delay"].index,
					channelIndex,
					tone.instrumentIndex
				)
			) {
				delayTicks =
					this.getModValue(
						Config.modulators.dictionary["vibrato delay"].index,
						channelIndex,
						tone.instrumentIndex,
						false
					) * 2; // Delay was changed from parts to ticks in BB v9
				if (delayTicks == Config.modulators.dictionary["vibrato delay"].maxRawVol * 2)
					delayTicks = Number.POSITIVE_INFINITY;
			}

			if (
				this.isModActive(
					Config.modulators.dictionary["vibrato depth"].index,
					channelIndex,
					tone.instrumentIndex
				)
			) {
				vibratoAmplitudeStart =
					this.getModValue(
						Config.modulators.dictionary["vibrato depth"].index,
						channelIndex,
						tone.instrumentIndex,
						false
					) / 25;
				vibratoAmplitudeEnd =
					this.getModValue(
						Config.modulators.dictionary["vibrato depth"].index,
						channelIndex,
						tone.instrumentIndex,
						true
					) / 25;
			}

			// To maintain pitch continuity, (mostly for picked string which retriggers impulse
			// otherwise) remember the vibrato at the end of this run and reuse it at the start
			// of the next run if available.
			let vibratoStart: number;
			if (tone.prevVibrato != null) {
				vibratoStart = tone.prevVibrato;
			} else {
				let lfoStart: number = Synth.getLFOAmplitude(instrument, secondsPerPart * instrument.LFOtime);
				const vibratoDepthEnvelopeStart: number = envelopeStarts[EnvelopeComputeIndex.vibratoDepth];
				vibratoStart = vibratoAmplitudeStart * lfoStart * vibratoDepthEnvelopeStart;
				if (delayTicks > 0.0) {
					const ticksUntilVibratoStart: number = delayTicks - envelopeComputer.noteTicksStart;
					vibratoStart *= Math.max(0.0, Math.min(1.0, 1.0 - ticksUntilVibratoStart / 2.0));
				}
			}

			let lfoEnd: number = Synth.getLFOAmplitude(instrument, secondsPerPart * instrument.nextLFOtime);
			const vibratoDepthEnvelopeEnd: number = envelopeEnds[EnvelopeComputeIndex.vibratoDepth];
			if (instrument.type != InstrumentType.mod) {
				let vibratoEnd: number = vibratoAmplitudeEnd * lfoEnd * vibratoDepthEnvelopeEnd;
				if (delayTicks > 0.0) {
					const ticksUntilVibratoEnd: number = delayTicks - envelopeComputer.noteTicksEnd;
					vibratoEnd *= Math.max(0.0, Math.min(1.0, 1.0 - ticksUntilVibratoEnd / 2.0));
				}

				tone.prevVibrato = vibratoEnd;

				intervalStart += vibratoStart;
				intervalEnd += vibratoEnd;
			}
		}

		if ((!transition.isSeamless && !tone.forceContinueAtStart) || tone.prevNote == null) {
			// Fade in the beginning of the note.
			const fadeInSeconds: number = instrument.getFadeInSeconds();
			if (fadeInSeconds > 0.0) {
				fadeExpressionStart *= Math.min(1.0, envelopeComputer.noteSecondsStart / fadeInSeconds);
				fadeExpressionEnd *= Math.min(1.0, envelopeComputer.noteSecondsEnd / fadeInSeconds);
			}
		}

		if (instrument.type == InstrumentType.drumset && tone.drumsetPitch == null) {
			// It's possible that the note will change while the user is editing it,
			// but the tone's pitches don't get updated because the tone has already
			// ended and is fading out. To avoid an array index out of bounds error, clamp the pitch.
			tone.drumsetPitch = tone.pitches[0];
			if (tone.note != null) tone.drumsetPitch += tone.note.pickMainInterval();
			tone.drumsetPitch = Math.max(0, Math.min(Config.drumCount - 1, tone.drumsetPitch));
		}

		let noteFilterExpression: number = envelopeComputer.lowpassCutoffDecayVolumeCompensation;
		if (!effectsIncludeNoteFilter(instrument.effects)) {
			tone.noteFilterCount = 0;
		} else {
			const noteAllFreqsEnvelopeStart: number = envelopeStarts[EnvelopeComputeIndex.noteFilterAllFreqs];
			const noteAllFreqsEnvelopeEnd: number = envelopeEnds[EnvelopeComputeIndex.noteFilterAllFreqs];

			// Simple note filter
			if (instrument.noteFilterType) {
				const noteFreqEnvelopeStart: number = envelopeStarts[EnvelopeComputeIndex.noteFilterFreq0];
				const noteFreqEnvelopeEnd: number = envelopeEnds[EnvelopeComputeIndex.noteFilterFreq0];
				const notePeakEnvelopeStart: number = envelopeStarts[EnvelopeComputeIndex.noteFilterGain0];
				const notePeakEnvelopeEnd: number = envelopeEnds[EnvelopeComputeIndex.noteFilterGain0];

				startPoint!.toCoefficients(
					Synth.tempFilterStartCoefficients,
					this.samplesPerSecond,
					noteAllFreqsEnvelopeStart * noteFreqEnvelopeStart,
					notePeakEnvelopeStart
				);
				endPoint!.toCoefficients(
					Synth.tempFilterEndCoefficients,
					this.samplesPerSecond,
					noteAllFreqsEnvelopeEnd * noteFreqEnvelopeEnd,
					notePeakEnvelopeEnd
				);

				if (tone.noteFilters.length < 1) tone.noteFilters[0] = new DynamicBiquadFilter();
				tone.noteFilters[0].loadCoefficientsWithGradient(
					Synth.tempFilterStartCoefficients,
					Synth.tempFilterEndCoefficients,
					1.0 / roundedSamplesPerTick,
					startPoint!.type == FilterType.lowPass
				);
				noteFilterExpression *= startPoint!.getVolumeCompensationMult();

				tone.noteFilterCount = 1;
			} else {
				const noteFilterSettings: FilterSettings =
					instrument.tmpNoteFilterStart != null ? instrument.tmpNoteFilterStart : instrument.noteFilter;

				for (let i: number = 0; i < noteFilterSettings.controlPointCount; i++) {
					const noteFreqEnvelopeStart: number = envelopeStarts[EnvelopeComputeIndex.noteFilterFreq0 + i];
					const noteFreqEnvelopeEnd: number = envelopeEnds[EnvelopeComputeIndex.noteFilterFreq0 + i];
					const notePeakEnvelopeStart: number = envelopeStarts[EnvelopeComputeIndex.noteFilterGain0 + i];
					const notePeakEnvelopeEnd: number = envelopeEnds[EnvelopeComputeIndex.noteFilterGain0 + i];
					let startPoint: FilterControlPoint = noteFilterSettings.controlPoints[i];
					const endPoint: FilterControlPoint =
						instrument.tmpNoteFilterEnd != null && instrument.tmpNoteFilterEnd.controlPoints[i] != null
							? instrument.tmpNoteFilterEnd.controlPoints[i]
							: noteFilterSettings.controlPoints[i];

					// If switching dot type, do it all at once and do not try to interpolate since no valid interpolation exists.
					if (startPoint.type != endPoint.type) {
						startPoint = endPoint;
					}

					startPoint.toCoefficients(
						Synth.tempFilterStartCoefficients,
						this.samplesPerSecond,
						noteAllFreqsEnvelopeStart * noteFreqEnvelopeStart,
						notePeakEnvelopeStart
					);
					endPoint.toCoefficients(
						Synth.tempFilterEndCoefficients,
						this.samplesPerSecond,
						noteAllFreqsEnvelopeEnd * noteFreqEnvelopeEnd,
						notePeakEnvelopeEnd
					);
					if (tone.noteFilters.length <= i) tone.noteFilters[i] = new DynamicBiquadFilter();
					tone.noteFilters[i].loadCoefficientsWithGradient(
						Synth.tempFilterStartCoefficients,
						Synth.tempFilterEndCoefficients,
						1.0 / roundedSamplesPerTick,
						startPoint.type == FilterType.lowPass
					);
					noteFilterExpression *= startPoint.getVolumeCompensationMult();
				}
				tone.noteFilterCount = noteFilterSettings.controlPointCount;
			}
		}

		if (instrument.type == InstrumentType.drumset) {
			const drumsetFilterEnvelope: Envelope = instrument.getDrumsetEnvelope(tone.drumsetPitch!);
			// If the drumset lowpass cutoff decays, compensate by increasing expression.
			noteFilterExpression *= EnvelopeComputer.getLowpassCutoffDecayVolumeCompensation(drumsetFilterEnvelope);

			// Drumset filters use the same envelope timing as the rest of the envelopes, but do not include support for slide transitions.
			let drumsetFilterEnvelopeStart: number = EnvelopeComputer.computeEnvelope(
				drumsetFilterEnvelope,
				envelopeComputer.noteSecondsStart,
				beatsPerPart * partTimeStart,
				envelopeComputer.noteSizeStart
			);
			let drumsetFilterEnvelopeEnd: number = EnvelopeComputer.computeEnvelope(
				drumsetFilterEnvelope,
				envelopeComputer.noteSecondsEnd,
				beatsPerPart * partTimeEnd,
				envelopeComputer.noteSizeEnd
			);

			// Apply slide interpolation to drumset envelope.
			if (envelopeComputer.prevSlideStart) {
				const other: number = EnvelopeComputer.computeEnvelope(
					drumsetFilterEnvelope,
					envelopeComputer.prevNoteSecondsStart,
					beatsPerPart * partTimeStart,
					envelopeComputer.prevNoteSize
				);
				drumsetFilterEnvelopeStart +=
					(other - drumsetFilterEnvelopeStart) * envelopeComputer.prevSlideRatioStart;
			}
			if (envelopeComputer.prevSlideEnd) {
				const other: number = EnvelopeComputer.computeEnvelope(
					drumsetFilterEnvelope,
					envelopeComputer.prevNoteSecondsEnd,
					beatsPerPart * partTimeEnd,
					envelopeComputer.prevNoteSize
				);
				drumsetFilterEnvelopeEnd += (other - drumsetFilterEnvelopeEnd) * envelopeComputer.prevSlideRatioEnd;
			}
			if (envelopeComputer.nextSlideStart) {
				const other: number = EnvelopeComputer.computeEnvelope(
					drumsetFilterEnvelope,
					0.0,
					beatsPerPart * partTimeStart,
					envelopeComputer.nextNoteSize
				);
				drumsetFilterEnvelopeStart +=
					(other - drumsetFilterEnvelopeStart) * envelopeComputer.nextSlideRatioStart;
			}
			if (envelopeComputer.nextSlideEnd) {
				const other: number = EnvelopeComputer.computeEnvelope(
					drumsetFilterEnvelope,
					0.0,
					beatsPerPart * partTimeEnd,
					envelopeComputer.nextNoteSize
				);
				drumsetFilterEnvelopeEnd += (other - drumsetFilterEnvelopeEnd) * envelopeComputer.nextSlideRatioEnd;
			}

			const point: FilterControlPoint = this.tempDrumSetControlPoint;
			point.type = FilterType.lowPass;
			point.gain = FilterControlPoint.getRoundedSettingValueFromLinearGain(0.5);
			point.freq = FilterControlPoint.getRoundedSettingValueFromHz(8000.0);
			// Drumset envelopes are warped to better imitate the legacy simplified 2nd order lowpass at ~48000Hz that I used to use.
			point.toCoefficients(
				Synth.tempFilterStartCoefficients,
				this.samplesPerSecond,
				drumsetFilterEnvelopeStart * (1.0 + drumsetFilterEnvelopeStart),
				1.0
			);
			point.toCoefficients(
				Synth.tempFilterEndCoefficients,
				this.samplesPerSecond,
				drumsetFilterEnvelopeEnd * (1.0 + drumsetFilterEnvelopeEnd),
				1.0
			);
			if (tone.noteFilters.length == tone.noteFilterCount)
				tone.noteFilters[tone.noteFilterCount] = new DynamicBiquadFilter();
			tone.noteFilters[tone.noteFilterCount].loadCoefficientsWithGradient(
				Synth.tempFilterStartCoefficients,
				Synth.tempFilterEndCoefficients,
				1.0 / roundedSamplesPerTick,
				true
			);
			tone.noteFilterCount++;
		}

		noteFilterExpression = Math.min(3.0, noteFilterExpression);

		if (instrument.type == InstrumentType.fm) {
			// phase modulation!

			let sineExpressionBoost: number = 1.0;
			let totalCarrierExpression: number = 0.0;

			let arpeggioInterval: number = 0;
			const arpeggiates: boolean = chord.arpeggiates;
			if (tone.pitchCount > 1 && arpeggiates) {
				const arpeggio: number = Math.floor(instrument.arpTime / Config.ticksPerArpeggio);
				arpeggioInterval =
					tone.pitches[getArpeggioPitchIndex(tone.pitchCount, instrument.fastTwoNoteArp, arpeggio)] -
					tone.pitches[0];
			}

			const carrierCount: number = Config.algorithms[instrument.algorithm].carrierCount;
			for (let i: number = 0; i < Config.operatorCount; i++) {
				const associatedCarrierIndex: number = Config.algorithms[instrument.algorithm].associatedCarrier[i] - 1;
				const pitch: number =
					tone.pitches[
						arpeggiates
							? 0
							: i < tone.pitchCount
							? i
							: associatedCarrierIndex < tone.pitchCount
							? associatedCarrierIndex
							: 0
					];
				const freqMult = Config.operatorFrequencies[instrument.operators[i].frequency].mult;
				const interval = Config.operatorCarrierInterval[associatedCarrierIndex] + arpeggioInterval;
				const pitchStart: number = basePitch + (pitch + intervalStart) * intervalScale + interval;
				const pitchEnd: number = basePitch + (pitch + intervalEnd) * intervalScale + interval;
				const baseFreqStart: number = Instrument.frequencyFromPitch(pitchStart);
				const baseFreqEnd: number = Instrument.frequencyFromPitch(pitchEnd);
				const hzOffset: number = Config.operatorFrequencies[instrument.operators[i].frequency].hzOffset;
				const targetFreqStart: number = freqMult * baseFreqStart + hzOffset;
				const targetFreqEnd: number = freqMult * baseFreqEnd + hzOffset;

				const freqEnvelopeStart: number = envelopeStarts[EnvelopeComputeIndex.operatorFrequency0 + i];
				const freqEnvelopeEnd: number = envelopeEnds[EnvelopeComputeIndex.operatorFrequency0 + i];
				let freqStart: number;
				let freqEnd: number;
				if (freqEnvelopeStart != 1.0 || freqEnvelopeEnd != 1.0) {
					freqStart =
						Math.pow(2.0, Math.log2(targetFreqStart / baseFreqStart) * freqEnvelopeStart) * baseFreqStart;
					freqEnd = Math.pow(2.0, Math.log2(targetFreqEnd / baseFreqEnd) * freqEnvelopeEnd) * baseFreqEnd;
				} else {
					freqStart = targetFreqStart;
					freqEnd = targetFreqEnd;
				}
				tone.phaseDeltas[i] = freqStart * sampleTime;
				tone.phaseDeltaScales[i] = Math.pow(freqEnd / freqStart, 1.0 / roundedSamplesPerTick);

				let amplitudeStart: number = instrument.operators[i].amplitude;
				let amplitudeEnd: number = instrument.operators[i].amplitude;
				if (
					this.isModActive(
						Config.modulators.dictionary["fm slider 1"].index + i,
						channelIndex,
						tone.instrumentIndex
					)
				) {
					amplitudeStart *=
						this.getModValue(
							Config.modulators.dictionary["fm slider 1"].index + i,
							channelIndex,
							tone.instrumentIndex,
							false
						) / 15.0;
					amplitudeEnd *=
						this.getModValue(
							Config.modulators.dictionary["fm slider 1"].index + i,
							channelIndex,
							tone.instrumentIndex,
							true
						) / 15.0;
				}

				const amplitudeCurveStart: number = Synth.operatorAmplitudeCurve(amplitudeStart);
				const amplitudeCurveEnd: number = Synth.operatorAmplitudeCurve(amplitudeEnd);
				const amplitudeMultStart: number =
					amplitudeCurveStart * Config.operatorFrequencies[instrument.operators[i].frequency].amplitudeSign;
				const amplitudeMultEnd: number =
					amplitudeCurveEnd * Config.operatorFrequencies[instrument.operators[i].frequency].amplitudeSign;

				let expressionStart: number = amplitudeMultStart;
				let expressionEnd: number = amplitudeMultEnd;

				if (i < carrierCount) {
					// carrier
					let pitchExpressionStart: number;
					if (tone.prevPitchExpressions[i] != null) {
						pitchExpressionStart = tone.prevPitchExpressions[i]!;
					} else {
						pitchExpressionStart = Math.pow(2.0, -(pitchStart - expressionReferencePitch) / pitchDamping);
					}
					const pitchExpressionEnd: number = Math.pow(
						2.0,
						-(pitchEnd - expressionReferencePitch) / pitchDamping
					);
					tone.prevPitchExpressions[i] = pitchExpressionEnd;
					expressionStart *= pitchExpressionStart;
					expressionEnd *= pitchExpressionEnd;

					totalCarrierExpression += amplitudeCurveEnd;
				} else {
					// modulator
					expressionStart *= Config.sineWaveLength * 1.5;
					expressionEnd *= Config.sineWaveLength * 1.5;

					sineExpressionBoost *= 1.0 - Math.min(1.0, instrument.operators[i].amplitude / 15);
				}

				expressionStart *= envelopeStarts[EnvelopeComputeIndex.operatorAmplitude0 + i];
				expressionEnd *= envelopeEnds[EnvelopeComputeIndex.operatorAmplitude0 + i];

				// Check for mod-related volume delta
				// @jummbus - This amplification is also applied to modulator FM operators which distorts the sound.
				// The fix is to apply this only to carriers, but as this is a legacy bug and it can cause some interesting sounds, it's left in.
				// You can use the mix volume modulator instead to avoid this effect.

				if (
					this.isModActive(
						Config.modulators.dictionary["note volume"].index,
						channelIndex,
						tone.instrumentIndex
					)
				) {
					// Linear falloff below 0, normal volume formula above 0. Seems to work best for scaling since the normal volume mult formula has a big gap from -25 to -24.
					const startVal: number = this.getModValue(
						Config.modulators.dictionary["note volume"].index,
						channelIndex,
						tone.instrumentIndex,
						false
					);
					const endVal: number = this.getModValue(
						Config.modulators.dictionary["note volume"].index,
						channelIndex,
						tone.instrumentIndex,
						true
					);
					expressionStart *=
						startVal <= 0
							? (startVal + Config.volumeRange / 2) / (Config.volumeRange / 2)
							: Synth.instrumentVolumeToVolumeMult(startVal);
					expressionEnd *=
						endVal <= 0
							? (endVal + Config.volumeRange / 2) / (Config.volumeRange / 2)
							: Synth.instrumentVolumeToVolumeMult(endVal);
				}

				tone.operatorExpressions[i] = expressionStart;
				tone.operatorExpressionDeltas[i] = (expressionEnd - expressionStart) / roundedSamplesPerTick;
			}

			sineExpressionBoost *= (Math.pow(2.0, 2.0 - (1.4 * instrument.feedbackAmplitude) / 15.0) - 1.0) / 3.0;
			sineExpressionBoost *= 1.0 - Math.min(1.0, Math.max(0.0, totalCarrierExpression - 1) / 2.0);
			sineExpressionBoost = 1.0 + sineExpressionBoost * 3.0;
			const expressionStart: number =
				baseExpression *
				sineExpressionBoost *
				noteFilterExpression *
				fadeExpressionStart *
				chordExpressionStart *
				envelopeStarts[EnvelopeComputeIndex.noteVolume];
			const expressionEnd: number =
				baseExpression *
				sineExpressionBoost *
				noteFilterExpression *
				fadeExpressionEnd *
				chordExpressionEnd *
				envelopeEnds[EnvelopeComputeIndex.noteVolume];
			tone.expression = expressionStart;
			tone.expressionDelta = (expressionEnd - expressionStart) / roundedSamplesPerTick;

			let useFeedbackAmplitudeStart: number = instrument.feedbackAmplitude;
			let useFeedbackAmplitudeEnd: number = instrument.feedbackAmplitude;
			if (
				this.isModActive(Config.modulators.dictionary["fm feedback"].index, channelIndex, tone.instrumentIndex)
			) {
				useFeedbackAmplitudeStart *=
					this.getModValue(
						Config.modulators.dictionary["fm feedback"].index,
						channelIndex,
						tone.instrumentIndex,
						false
					) / 15.0;
				useFeedbackAmplitudeEnd *=
					this.getModValue(
						Config.modulators.dictionary["fm feedback"].index,
						channelIndex,
						tone.instrumentIndex,
						true
					) / 15.0;
			}

			let feedbackAmplitudeStart: number = (Config.sineWaveLength * 0.3 * useFeedbackAmplitudeStart) / 15.0;
			const feedbackAmplitudeEnd: number = (Config.sineWaveLength * 0.3 * useFeedbackAmplitudeEnd) / 15.0;

			let feedbackStart: number = feedbackAmplitudeStart * envelopeStarts[EnvelopeComputeIndex.feedbackAmplitude];
			let feedbackEnd: number = feedbackAmplitudeEnd * envelopeEnds[EnvelopeComputeIndex.feedbackAmplitude];
			tone.feedbackMult = feedbackStart;
			tone.feedbackDelta = (feedbackEnd - feedbackStart) / roundedSamplesPerTick;
		} else {
			const basePhaseDeltaScale: number = Math.pow(
				2.0,
				((intervalEnd - intervalStart) * intervalScale) / 12.0 / roundedSamplesPerTick
			);

			let pitch: number = tone.pitches[0];
			if (tone.pitchCount > 1 && (chord.arpeggiates || chord.customInterval)) {
				const arpeggio: number = Math.floor(instrument.arpTime / Config.ticksPerArpeggio);
				if (chord.customInterval) {
					const intervalOffset: number =
						tone.pitches[
							1 + getArpeggioPitchIndex(tone.pitchCount - 1, instrument.fastTwoNoteArp, arpeggio)
						] - tone.pitches[0];
					specialIntervalMult = Math.pow(2.0, intervalOffset / 12.0);
					tone.specialIntervalExpressionMult = Math.pow(2.0, -intervalOffset / pitchDamping);
				} else {
					pitch = tone.pitches[getArpeggioPitchIndex(tone.pitchCount, instrument.fastTwoNoteArp, arpeggio)];
				}
			}

			const startPitch: number = basePitch + (pitch + intervalStart) * intervalScale;
			const endPitch: number = basePitch + (pitch + intervalEnd) * intervalScale;
			let pitchExpressionStart: number;
			// TODO: use the second element of prevPitchExpressions for the unison voice, compute a separate expression delta for it.
			if (tone.prevPitchExpressions[0] != null) {
				pitchExpressionStart = tone.prevPitchExpressions[0]!;
			} else {
				pitchExpressionStart = Math.pow(2.0, -(startPitch - expressionReferencePitch) / pitchDamping);
			}
			const pitchExpressionEnd: number = Math.pow(2.0, -(endPitch - expressionReferencePitch) / pitchDamping);
			tone.prevPitchExpressions[0] = pitchExpressionEnd;
			let settingsExpressionMult: number = baseExpression * noteFilterExpression;

			if (instrument.type == InstrumentType.noise) {
				settingsExpressionMult *= Config.chipNoises[instrument.chipNoise].expression;
			}
			if (instrument.type == InstrumentType.chip) {
				settingsExpressionMult *= Config.chipWaves[instrument.chipWave].expression;
			}
			if (instrument.type == InstrumentType.pwm) {
				const basePulseWidth: number = getPulseWidthRatio(instrument.pulseWidth);

				// Check for PWM mods to this instrument
				let pulseWidthModStart: number = basePulseWidth;
				let pulseWidthModEnd: number = basePulseWidth;
				if (
					this.isModActive(
						Config.modulators.dictionary["pulse width"].index,
						channelIndex,
						tone.instrumentIndex
					)
				) {
					pulseWidthModStart =
						this.getModValue(
							Config.modulators.dictionary["pulse width"].index,
							channelIndex,
							tone.instrumentIndex,
							false
						) /
						(Config.pulseWidthRange * 2);
					pulseWidthModEnd =
						this.getModValue(
							Config.modulators.dictionary["pulse width"].index,
							channelIndex,
							tone.instrumentIndex,
							true
						) /
						(Config.pulseWidthRange * 2);
				}

				const pulseWidthStart: number = pulseWidthModStart * envelopeStarts[EnvelopeComputeIndex.pulseWidth];
				const pulseWidthEnd: number = pulseWidthModEnd * envelopeEnds[EnvelopeComputeIndex.pulseWidth];
				tone.pulseWidth = pulseWidthStart;
				tone.pulseWidthDelta = (pulseWidthEnd - pulseWidthStart) / roundedSamplesPerTick;
			}
			if (instrument.type == InstrumentType.pickedString) {
				// Check for sustain mods
				let useSustainStart: number = instrument.stringSustain;
				let useSustainEnd: number = instrument.stringSustain;
				if (
					this.isModActive(Config.modulators.dictionary["sustain"].index, channelIndex, tone.instrumentIndex)
				) {
					useSustainStart = this.getModValue(
						Config.modulators.dictionary["sustain"].index,
						channelIndex,
						tone.instrumentIndex,
						false
					);
					useSustainEnd = this.getModValue(
						Config.modulators.dictionary["sustain"].index,
						channelIndex,
						tone.instrumentIndex,
						true
					);
				}

				tone.stringSustainStart = useSustainStart;
				tone.stringSustainEnd = useSustainEnd;

				// Increase expression to compensate for string decay.
				settingsExpressionMult *= Math.pow(
					2.0,
					0.7 * (1.0 - useSustainStart / (Config.stringSustainRange - 1))
				);
			}

			const startFreq: number = Instrument.frequencyFromPitch(startPitch);
			if (
				instrument.type == InstrumentType.chip ||
				instrument.type == InstrumentType.customChipWave ||
				instrument.type == InstrumentType.harmonics ||
				instrument.type == InstrumentType.pickedString
			) {
				// These instruments have two waves at different frequencies for the unison feature.
				const unison: Unison = Config.unisons[instrument.unison];
				const voiceCountExpression: number =
					instrument.type == InstrumentType.pickedString ? 1 : unison.voices / 2.0;
				settingsExpressionMult *= unison.expression * voiceCountExpression;
				const unisonEnvelopeStart = envelopeStarts[EnvelopeComputeIndex.unison];
				const unisonEnvelopeEnd = envelopeEnds[EnvelopeComputeIndex.unison];
				const unisonAStart: number = Math.pow(
					2.0,
					((unison.offset + unison.spread) * unisonEnvelopeStart) / 12.0
				);
				const unisonAEnd: number = Math.pow(2.0, ((unison.offset + unison.spread) * unisonEnvelopeEnd) / 12.0);
				const unisonBStart: number =
					Math.pow(2.0, ((unison.offset - unison.spread) * unisonEnvelopeStart) / 12.0) * specialIntervalMult;
				const unisonBEnd: number =
					Math.pow(2.0, ((unison.offset - unison.spread) * unisonEnvelopeEnd) / 12.0) * specialIntervalMult;
				tone.phaseDeltas[0] = startFreq * sampleTime * unisonAStart;
				tone.phaseDeltas[1] = startFreq * sampleTime * unisonBStart;
				tone.phaseDeltaScales[0] =
					basePhaseDeltaScale * Math.pow(unisonAEnd / unisonAStart, 1.0 / roundedSamplesPerTick);
				tone.phaseDeltaScales[1] =
					basePhaseDeltaScale * Math.pow(unisonBEnd / unisonBStart, 1.0 / roundedSamplesPerTick);
			} else {
				tone.phaseDeltas[0] = startFreq * sampleTime;
				tone.phaseDeltaScales[0] = basePhaseDeltaScale;
			}

			let expressionStart: number =
				settingsExpressionMult *
				fadeExpressionStart *
				chordExpressionStart *
				pitchExpressionStart *
				envelopeStarts[EnvelopeComputeIndex.noteVolume];
			let expressionEnd: number =
				settingsExpressionMult *
				fadeExpressionEnd *
				chordExpressionEnd *
				pitchExpressionEnd *
				envelopeEnds[EnvelopeComputeIndex.noteVolume];

			// Check for mod-related volume delta
			if (
				this.isModActive(Config.modulators.dictionary["note volume"].index, channelIndex, tone.instrumentIndex)
			) {
				// Linear falloff below 0, normal volume formula above 0. Seems to work best for scaling since the normal volume mult formula has a big gap from -25 to -24.
				const startVal: number = this.getModValue(
					Config.modulators.dictionary["note volume"].index,
					channelIndex,
					tone.instrumentIndex,
					false
				);
				const endVal: number = this.getModValue(
					Config.modulators.dictionary["note volume"].index,
					channelIndex,
					tone.instrumentIndex,
					true
				);
				expressionStart *=
					startVal <= 0
						? (startVal + Config.volumeRange / 2) / (Config.volumeRange / 2)
						: Synth.instrumentVolumeToVolumeMult(startVal);
				expressionEnd *=
					endVal <= 0
						? (endVal + Config.volumeRange / 2) / (Config.volumeRange / 2)
						: Synth.instrumentVolumeToVolumeMult(endVal);
			}

			tone.expression = expressionStart;
			tone.expressionDelta = (expressionEnd - expressionStart) / roundedSamplesPerTick;

			if (instrument.type == InstrumentType.pickedString) {
				let stringDecayStart: number;
				if (tone.prevStringDecay != null) {
					stringDecayStart = tone.prevStringDecay;
				} else {
					const sustainEnvelopeStart: number =
						tone.envelopeComputer.envelopeStarts[EnvelopeComputeIndex.stringSustain];
					stringDecayStart =
						1.0 -
						Math.min(
							1.0,
							(sustainEnvelopeStart * tone.stringSustainStart) / (Config.stringSustainRange - 1)
						);
				}
				const sustainEnvelopeEnd: number =
					tone.envelopeComputer.envelopeEnds[EnvelopeComputeIndex.stringSustain];
				let stringDecayEnd: number =
					1.0 - Math.min(1.0, (sustainEnvelopeEnd * tone.stringSustainEnd) / (Config.stringSustainRange - 1));
				tone.prevStringDecay = stringDecayEnd;

				const unison: Unison = Config.unisons[instrument.unison];
				for (let i: number = tone.pickedStrings.length; i < unison.voices; i++) {
					tone.pickedStrings[i] = new PickedString();
				}

				if (tone.atNoteStart && !transition.continues && !tone.forceContinueAtStart) {
					for (const pickedString of tone.pickedStrings) {
						// Force the picked string to retrigger the attack impulse at the start of the note.
						pickedString.delayIndex = -1;
					}
				}

				for (let i: number = 0; i < unison.voices; i++) {
					tone.pickedStrings[i].update(
						this,
						instrumentState,
						tone,
						i,
						roundedSamplesPerTick,
						stringDecayStart,
						stringDecayEnd
					);
				}
			}
		}
	}

	public static getLFOAmplitude(instrument: Instrument, secondsIntoBar: number): number {
		let effect: number = 0.0;
		for (const vibratoPeriodSeconds of Config.vibratoTypes[instrument.vibratoType].periodsSeconds) {
			effect += Math.sin((Math.PI * 2.0 * secondsIntoBar) / vibratoPeriodSeconds);
		}
		return effect;
	}

	public static getInstrumentSynthFunction(instrument: Instrument): Function {
		if (instrument.type == InstrumentType.fm) {
			const fingerprint: string = instrument.algorithm + "_" + instrument.feedbackType;
			if (Synth.fmSynthFunctionCache[fingerprint] == undefined) {
				const synthSource: string[] = [];

				for (const line of Synth.fmSourceTemplate) {
					if (line.indexOf("// CARRIER OUTPUTS") != -1) {
						const outputs: string[] = [];
						for (let j: number = 0; j < Config.algorithms[instrument.algorithm].carrierCount; j++) {
							outputs.push("operator" + j + "Scaled");
						}
						synthSource.push(line.replace("/*operator#Scaled*/", outputs.join(" + ")));
					} else if (line.indexOf("// INSERT OPERATOR COMPUTATION HERE") != -1) {
						for (let j: number = Config.operatorCount - 1; j >= 0; j--) {
							for (const operatorLine of Synth.operatorSourceTemplate) {
								if (operatorLine.indexOf("/* + operator@Scaled*/") != -1) {
									let modulators = "";
									for (const modulatorNumber of Config.algorithms[instrument.algorithm].modulatedBy[
										j
									]) {
										modulators += " + operator" + (modulatorNumber - 1) + "Scaled";
									}

									const feedbackIndices: ReadonlyArray<number> =
										Config.feedbacks[instrument.feedbackType].indices[j];
									if (feedbackIndices.length > 0) {
										modulators += " + feedbackMult * (";
										const feedbacks: string[] = [];
										for (const modulatorNumber of feedbackIndices) {
											feedbacks.push("operator" + (modulatorNumber - 1) + "Output");
										}
										modulators += feedbacks.join(" + ") + ")";
									}
									synthSource.push(
										operatorLine
											.replace(/\#/g, j + "")
											.replace("/* + operator@Scaled*/", modulators)
									);
								} else {
									synthSource.push(operatorLine.replace(/\#/g, j + ""));
								}
							}
						}
					} else if (line.indexOf("#") != -1) {
						for (let j: number = 0; j < Config.operatorCount; j++) {
							synthSource.push(line.replace(/\#/g, j + ""));
						}
					} else {
						synthSource.push(line);
					}
				}

				//console.log(synthSource.join("\n"));

				Synth.fmSynthFunctionCache[fingerprint] = new Function(
					"synth",
					"bufferIndex",
					"roundedSamplesPerTick",
					"tone",
					"instrumentState",
					synthSource.join("\n")
				);
			}
			return Synth.fmSynthFunctionCache[fingerprint];
		} else if (instrument.type == InstrumentType.chip) {
			return Synth.chipSynth;
		} else if (instrument.type == InstrumentType.customChipWave) {
			return Synth.chipSynth;
		} else if (instrument.type == InstrumentType.harmonics) {
			return Synth.harmonicsSynth;
		} else if (instrument.type == InstrumentType.pwm) {
			return Synth.pulseWidthSynth;
		} else if (instrument.type == InstrumentType.pickedString) {
			return Synth.pickedStringSynth;
		} else if (instrument.type == InstrumentType.noise) {
			return Synth.noiseSynth;
		} else if (instrument.type == InstrumentType.spectrum) {
			return Synth.spectrumSynth;
		} else if (instrument.type == InstrumentType.drumset) {
			return Synth.drumsetSynth;
		} else if (instrument.type == InstrumentType.mod) {
			return Synth.modSynth;
		} else {
			throw new Error("Unrecognized instrument type: " + instrument.type);
		}
	}

	private static chipSynth(
		synth: Synth,
		bufferIndex: number,
		roundedSamplesPerTick: number,
		tone: Tone,
		instrumentState: InstrumentState
	): void {
		const aliases: boolean = effectsIncludeDistortion(instrumentState.effects) && instrumentState.aliases;
		const data: Float32Array = synth.tempMonoInstrumentSampleBuffer!;
		const wave: Float32Array = instrumentState.wave!;
		const volumeScale = instrumentState.volumeScale;

		// For all but aliasing custom chip, the first sample is duplicated at the end, so don't double-count it.
		const waveLength: number =
			aliases && instrumentState.type == InstrumentType.customChipWave ? wave.length : wave.length - 1;

		const unisonSign: number = tone.specialIntervalExpressionMult * instrumentState.unison!.sign;
		if (instrumentState.unison!.voices == 1 && !instrumentState.chord!.customInterval)
			tone.phases[1] = tone.phases[0];
		let phaseDeltaA: number = tone.phaseDeltas[0] * waveLength;
		let phaseDeltaB: number = tone.phaseDeltas[1] * waveLength;
		const phaseDeltaScaleA: number = +tone.phaseDeltaScales[0];
		const phaseDeltaScaleB: number = +tone.phaseDeltaScales[1];
		let expression: number = +tone.expression;
		const expressionDelta: number = +tone.expressionDelta;
		let phaseA: number = (tone.phases[0] % 1) * waveLength;
		let phaseB: number = (tone.phases[1] % 1) * waveLength;

		const filters: DynamicBiquadFilter[] = tone.noteFilters;
		const filterCount: number = tone.noteFilterCount | 0;
		let initialFilterInput1: number = +tone.initialNoteFilterInput1;
		let initialFilterInput2: number = +tone.initialNoteFilterInput2;
		const applyFilters: Function = Synth.applyFilters;
		let prevWaveIntegralA: number = 0;
		let prevWaveIntegralB: number = 0;

		if (!aliases) {
			const phaseAInt: number = phaseA | 0;
			const phaseBInt: number = phaseB | 0;
			const indexA: number = phaseAInt % waveLength;
			const indexB: number = phaseBInt % waveLength;
			const phaseRatioA: number = phaseA - phaseAInt;
			const phaseRatioB: number = phaseB - phaseBInt;
			prevWaveIntegralA = +wave[indexA];
			prevWaveIntegralB = +wave[indexB];
			prevWaveIntegralA += (wave[indexA + 1] - prevWaveIntegralA) * phaseRatioA;
			prevWaveIntegralB += (wave[indexB + 1] - prevWaveIntegralB) * phaseRatioB;
		}

		const stopIndex: number = bufferIndex + roundedSamplesPerTick;
		for (let sampleIndex: number = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
			phaseA += phaseDeltaA;
			phaseB += phaseDeltaB;

			let waveA: number;
			let waveB: number;
			let inputSample: number;

			if (aliases) {
				waveA = wave[(0 | phaseA) % waveLength];
				waveB = wave[(0 | phaseB) % waveLength];
				inputSample = waveA + waveB;
			} else {
				const phaseAInt: number = phaseA | 0;
				const phaseBInt: number = phaseB | 0;
				const indexA: number = phaseAInt % waveLength;
				const indexB: number = phaseBInt % waveLength;
				let nextWaveIntegralA: number = wave[indexA];
				let nextWaveIntegralB: number = wave[indexB];
				const phaseRatioA: number = phaseA - phaseAInt;
				const phaseRatioB: number = phaseB - phaseBInt;
				nextWaveIntegralA += (wave[indexA + 1] - nextWaveIntegralA) * phaseRatioA;
				nextWaveIntegralB += (wave[indexB + 1] - nextWaveIntegralB) * phaseRatioB;
				waveA = (nextWaveIntegralA - prevWaveIntegralA) / phaseDeltaA;
				waveB = (nextWaveIntegralB - prevWaveIntegralB) / phaseDeltaB;
				prevWaveIntegralA = nextWaveIntegralA;
				prevWaveIntegralB = nextWaveIntegralB;
				inputSample = waveA + waveB * unisonSign;
			}

			const sample: number = applyFilters(
				inputSample * volumeScale,
				initialFilterInput1,
				initialFilterInput2,
				filterCount,
				filters
			);
			initialFilterInput2 = initialFilterInput1;
			initialFilterInput1 = inputSample * volumeScale;

			phaseDeltaA *= phaseDeltaScaleA;
			phaseDeltaB *= phaseDeltaScaleB;

			const output: number = sample * expression;
			expression += expressionDelta;

			data[sampleIndex] += output;
		}

		tone.phases[0] = phaseA / waveLength;
		tone.phases[1] = phaseB / waveLength;
		tone.phaseDeltas[0] = phaseDeltaA / waveLength;
		tone.phaseDeltas[1] = phaseDeltaB / waveLength;
		tone.expression = expression;

		synth.sanitizeFilters(filters);
		tone.initialNoteFilterInput1 = initialFilterInput1;
		tone.initialNoteFilterInput2 = initialFilterInput2;
	}

	private static harmonicsSynth(
		synth: Synth,
		bufferIndex: number,
		roundedSamplesPerTick: number,
		tone: Tone,
		instrumentState: InstrumentState
	): void {
		const data: Float32Array = synth.tempMonoInstrumentSampleBuffer!;
		const wave: Float32Array = instrumentState.wave!;
		const waveLength: number = wave.length - 1; // The first sample is duplicated at the end, don't double-count it.

		const unisonSign: number = tone.specialIntervalExpressionMult * instrumentState.unison!.sign;
		if (instrumentState.unison!.voices == 1 && !instrumentState.chord!.customInterval)
			tone.phases[1] = tone.phases[0];
		let phaseDeltaA: number = tone.phaseDeltas[0] * waveLength;
		let phaseDeltaB: number = tone.phaseDeltas[1] * waveLength;
		const phaseDeltaScaleA: number = +tone.phaseDeltaScales[0];
		const phaseDeltaScaleB: number = +tone.phaseDeltaScales[1];
		let expression: number = +tone.expression;
		const expressionDelta: number = +tone.expressionDelta;
		let phaseA: number = (tone.phases[0] % 1) * waveLength;
		let phaseB: number = (tone.phases[1] % 1) * waveLength;

		const filters: DynamicBiquadFilter[] = tone.noteFilters;
		const filterCount: number = tone.noteFilterCount | 0;
		let initialFilterInput1: number = +tone.initialNoteFilterInput1;
		let initialFilterInput2: number = +tone.initialNoteFilterInput2;
		const applyFilters: Function = Synth.applyFilters;

		const phaseAInt: number = phaseA | 0;
		const phaseBInt: number = phaseB | 0;
		const indexA: number = phaseAInt % waveLength;
		const indexB: number = phaseBInt % waveLength;
		const phaseRatioA: number = phaseA - phaseAInt;
		const phaseRatioB: number = phaseB - phaseBInt;
		let prevWaveIntegralA: number = +wave[indexA];
		let prevWaveIntegralB: number = +wave[indexB];
		prevWaveIntegralA += (wave[indexA + 1] - prevWaveIntegralA) * phaseRatioA;
		prevWaveIntegralB += (wave[indexB + 1] - prevWaveIntegralB) * phaseRatioB;

		const stopIndex: number = bufferIndex + roundedSamplesPerTick;
		for (let sampleIndex: number = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
			phaseA += phaseDeltaA;
			phaseB += phaseDeltaB;

			const phaseAInt: number = phaseA | 0;
			const phaseBInt: number = phaseB | 0;
			const indexA: number = phaseAInt % waveLength;
			const indexB: number = phaseBInt % waveLength;
			let nextWaveIntegralA: number = wave[indexA];
			let nextWaveIntegralB: number = wave[indexB];
			const phaseRatioA: number = phaseA - phaseAInt;
			const phaseRatioB: number = phaseB - phaseBInt;
			nextWaveIntegralA += (wave[indexA + 1] - nextWaveIntegralA) * phaseRatioA;
			nextWaveIntegralB += (wave[indexB + 1] - nextWaveIntegralB) * phaseRatioB;
			const waveA: number = (nextWaveIntegralA - prevWaveIntegralA) / phaseDeltaA;
			const waveB: number = (nextWaveIntegralB - prevWaveIntegralB) / phaseDeltaB;
			prevWaveIntegralA = nextWaveIntegralA;
			prevWaveIntegralB = nextWaveIntegralB;

			const inputSample: number = waveA + waveB * unisonSign;
			const sample: number = applyFilters(
				inputSample,
				initialFilterInput1,
				initialFilterInput2,
				filterCount,
				filters
			);
			initialFilterInput2 = initialFilterInput1;
			initialFilterInput1 = inputSample;

			phaseDeltaA *= phaseDeltaScaleA;
			phaseDeltaB *= phaseDeltaScaleB;

			const output: number = sample * expression;
			expression += expressionDelta;

			data[sampleIndex] += output;
		}

		tone.phases[0] = phaseA / waveLength;
		tone.phases[1] = phaseB / waveLength;
		tone.phaseDeltas[0] = phaseDeltaA / waveLength;
		tone.phaseDeltas[1] = phaseDeltaB / waveLength;
		tone.expression = expression;

		synth.sanitizeFilters(filters);
		tone.initialNoteFilterInput1 = initialFilterInput1;
		tone.initialNoteFilterInput2 = initialFilterInput2;
	}

	private static pickedStringSynth(
		synth: Synth,
		bufferIndex: number,
		roundedSamplesPerTick: number,
		tone: Tone,
		instrumentState: InstrumentState
	): void {
		// This algorithm is similar to the Karpluss-Strong algorithm in principle, but with an
		// all-pass filter for dispersion and with more control over the impulse harmonics.
		// The source code is processed as a string before being compiled, in order to
		// handle the unison feature. If unison is disabled or set to none, then only one
		// string voice is required, otherwise two string voices are required. We only want
		// to compute the minimum possible number of string voices, so omit the code for
		// processing extra ones if possible. Any line containing a "#" is duplicated for
		// each required voice, replacing the "#" with the voice index.

		const voiceCount: number = instrumentState.unison!.voices;
		let pickedStringFunction: Function = Synth.pickedStringFunctionCache[voiceCount];
		if (pickedStringFunction == undefined) {
			let pickedStringSource: string = "";

			pickedStringSource += `
				const Config = beepbox.Config;
				const Synth = beepbox.Synth;
				const data = synth.tempMonoInstrumentSampleBuffer;
				
				let pickedString# = tone.pickedStrings[#];
				let allPassSample# = +pickedString#.allPassSample;
				let allPassPrevInput# = +pickedString#.allPassPrevInput;
				let shelfSample# = +pickedString#.shelfSample;
				let shelfPrevInput# = +pickedString#.shelfPrevInput;
				let fractionalDelaySample# = +pickedString#.fractionalDelaySample;
				const delayLine# = pickedString#.delayLine;
				const delayBufferMask# = (delayLine#.length - 1) >> 0;
				let delayIndex# = pickedString#.delayIndex|0;
				delayIndex# = (delayIndex# & delayBufferMask#) + delayLine#.length;
				let delayLength# = +pickedString#.prevDelayLength;
				const delayLengthDelta# = +pickedString#.delayLengthDelta;
				let allPassG# = +pickedString#.allPassG;
				let shelfA1# = +pickedString#.shelfA1;
				let shelfB0# = +pickedString#.shelfB0;
				let shelfB1# = +pickedString#.shelfB1;
				const allPassGDelta# = +pickedString#.allPassGDelta;
				const shelfA1Delta# = +pickedString#.shelfA1Delta;
				const shelfB0Delta# = +pickedString#.shelfB0Delta;
				const shelfB1Delta# = +pickedString#.shelfB1Delta;
				
				let expression = +tone.expression;
				const expressionDelta = +tone.expressionDelta;
				
				const unisonSign = tone.specialIntervalExpressionMult * instrumentState.unison.sign;
				const delayResetOffset# = pickedString#.delayResetOffset|0;
				
				const filters = tone.noteFilters;
				const filterCount = tone.noteFilterCount|0;
				let initialFilterInput1 = +tone.initialNoteFilterInput1;
				let initialFilterInput2 = +tone.initialNoteFilterInput2;
				const applyFilters = Synth.applyFilters;
				
				const stopIndex = bufferIndex + runLength;
				for (let sampleIndex = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
					const targetSampleTime# = delayIndex# - delayLength#;
					const lowerIndex# = (targetSampleTime# + 0.125) | 0; // Offset to improve stability of all-pass filter.
					const upperIndex# = lowerIndex# + 1;
					const fractionalDelay# = upperIndex# - targetSampleTime#;
					const fractionalDelayG# = (1.0 - fractionalDelay#) / (1.0 + fractionalDelay#); // Inlined version of FilterCoefficients.prototype.allPass1stOrderFractionalDelay
					const prevInput# = delayLine#[lowerIndex# & delayBufferMask#];
					const input# = delayLine#[upperIndex# & delayBufferMask#];
					fractionalDelaySample# = fractionalDelayG# * input# + prevInput# - fractionalDelayG# * fractionalDelaySample#;
					
					allPassSample# = fractionalDelaySample# * allPassG# + allPassPrevInput# - allPassG# * allPassSample#;
					allPassPrevInput# = fractionalDelaySample#;
					
					shelfSample# = shelfB0# * allPassSample# + shelfB1# * shelfPrevInput# - shelfA1# * shelfSample#;
					shelfPrevInput# = allPassSample#;
					
					delayLine#[delayIndex# & delayBufferMask#] += shelfSample#;
					delayLine#[(delayIndex# + delayResetOffset#) & delayBufferMask#] = 0.0;
					delayIndex#++;
					
					const inputSample = (`;

			const sampleList: string[] = [];
			for (let voice: number = 0; voice < voiceCount; voice++) {
				sampleList.push("fractionalDelaySample" + voice + (voice == 1 ? " * unisonSign" : ""));
			}

			pickedStringSource += sampleList.join(" + ");

			pickedStringSource += `) * expression;
					const sample = applyFilters(inputSample, initialFilterInput1, initialFilterInput2, filterCount, filters);
					initialFilterInput2 = initialFilterInput1;
					initialFilterInput1 = inputSample;
					data[sampleIndex] += sample;
					
					expression += expressionDelta;
					delayLength# += delayLengthDelta#;
					allPassG# += allPassGDelta#;
					shelfA1# += shelfA1Delta#;
					shelfB0# += shelfB0Delta#;
					shelfB1# += shelfB1Delta#;
				}
				
				// Avoid persistent denormal or NaN values in the delay buffers and filter history.
				const epsilon = (1.0e-24);
				if (!Number.isFinite(allPassSample#) || Math.abs(allPassSample#) < epsilon) allPassSample# = 0.0;
				if (!Number.isFinite(allPassPrevInput#) || Math.abs(allPassPrevInput#) < epsilon) allPassPrevInput# = 0.0;
				if (!Number.isFinite(shelfSample#) || Math.abs(shelfSample#) < epsilon) shelfSample# = 0.0;
				if (!Number.isFinite(shelfPrevInput#) || Math.abs(shelfPrevInput#) < epsilon) shelfPrevInput# = 0.0;
				if (!Number.isFinite(fractionalDelaySample#) || Math.abs(fractionalDelaySample#) < epsilon) fractionalDelaySample# = 0.0;
				pickedString#.allPassSample = allPassSample#;
				pickedString#.allPassPrevInput = allPassPrevInput#;
				pickedString#.shelfSample = shelfSample#;
				pickedString#.shelfPrevInput = shelfPrevInput#;
				pickedString#.fractionalDelaySample = fractionalDelaySample#;
				pickedString#.delayIndex = delayIndex#;
				pickedString#.prevDelayLength = delayLength#;
				pickedString#.allPassG = allPassG#;
				pickedString#.shelfA1 = shelfA1#;
				pickedString#.shelfB0 = shelfB0#;
				pickedString#.shelfB1 = shelfB1#;
				
				tone.expression = expression;
				
				synth.sanitizeFilters(filters);
				tone.initialNoteFilterInput1 = initialFilterInput1;
				tone.initialNoteFilterInput2 = initialFilterInput2;`;

			// Duplicate lines containing "#" for each voice and replace the "#" with the voice index.
			pickedStringSource = pickedStringSource.replace(/^.*\#.*$/gm, line => {
				const lines = [];
				for (let voice: number = 0; voice < voiceCount; voice++) {
					lines.push(line.replace(/\#/g, String(voice)));
				}
				return lines.join("\n");
			});

			//console.log(pickedStringSource);
			pickedStringFunction = new Function(
				"synth",
				"bufferIndex",
				"runLength",
				"tone",
				"instrumentState",
				pickedStringSource
			);
			Synth.pickedStringFunctionCache[voiceCount] = pickedStringFunction;
		}

		pickedStringFunction(synth, bufferIndex, roundedSamplesPerTick, tone, instrumentState);
	}

	private static effectsSynth(
		synth: Synth,
		outputDataL: Float32Array,
		outputDataR: Float32Array,
		bufferIndex: number,
		runLength: number,
		instrumentState: InstrumentState
	): void {
		// TODO: If automation is involved, don't assume sliders will stay at zero.
		// @jummbus - ^ Correct, removed the non-zero checks as modulation can change them.

		const usesDistortion: boolean = effectsIncludeDistortion(instrumentState.effects);
		const usesBitcrusher: boolean = effectsIncludeBitcrusher(instrumentState.effects);
		const usesEqFilter: boolean = instrumentState.eqFilterCount > 0;
		const usesPanning: boolean = effectsIncludePanning(instrumentState.effects);
		const usesChorus: boolean = effectsIncludeChorus(instrumentState.effects);
		const usesEcho: boolean = effectsIncludeEcho(instrumentState.effects);
		const usesReverb: boolean = effectsIncludeReverb(instrumentState.effects);
		let signature: number = 0;
		if (usesDistortion) signature = signature | 1;
		signature = signature << 1;
		if (usesBitcrusher) signature = signature | 1;
		signature = signature << 1;
		if (usesEqFilter) signature = signature | 1;
		signature = signature << 1;
		if (usesPanning) signature = signature | 1;
		signature = signature << 1;
		if (usesChorus) signature = signature | 1;
		signature = signature << 1;
		if (usesEcho) signature = signature | 1;
		signature = signature << 1;
		if (usesReverb) signature = signature | 1;

		let effectsFunction: Function = Synth.effectsFunctionCache[signature];
		if (effectsFunction == undefined) {
			let effectsSource: string = "";

			const usesDelays: boolean = usesChorus || usesReverb || usesEcho;

			effectsSource += `
				const Config = beepbox.Config;
				const tempMonoInstrumentSampleBuffer = synth.tempMonoInstrumentSampleBuffer;
				
				let mixVolume = +instrumentState.mixVolume;
				const mixVolumeDelta = +instrumentState.mixVolumeDelta;`;

			if (usesDelays) {
				effectsSource += `
				
				let delayInputMult = +instrumentState.delayInputMult;
				const delayInputMultDelta = +instrumentState.delayInputMultDelta;`;
			}

			if (usesDistortion) {
				// Distortion can sometimes create noticeable aliasing.
				// It seems the established industry best practice for distortion antialiasing
				// is to upsample the inputs ("zero stuffing" followed by a brick wall lowpass
				// at the original nyquist frequency), perform the distortion, then downsample
				// (the lowpass again followed by dropping in-between samples). This is
				// "mathematically correct" in that it preserves only the intended frequencies,
				// but it has several unfortunate tradeoffs depending on the choice of filter,
				// introducing latency and/or time smearing, since no true brick wall filter
				// exists. For the time being, I've opted to instead generate in-between input
				// samples using fractional delay all-pass filters, and after distorting them,
				// I "downsample" these with a simple weighted sum.

				effectsSource += `
				
				const distortionBaseVolume = +Config.distortionBaseVolume;
				let distortion = instrumentState.distortion;
				const distortionDelta = instrumentState.distortionDelta;
				let distortionDrive = instrumentState.distortionDrive;
				const distortionDriveDelta = instrumentState.distortionDriveDelta;
				const distortionFractionalResolution = 4.0;
				const distortionOversampleCompensation = distortionBaseVolume / distortionFractionalResolution;
				const distortionFractionalDelay1 = 1.0 / distortionFractionalResolution;
				const distortionFractionalDelay2 = 2.0 / distortionFractionalResolution;
				const distortionFractionalDelay3 = 3.0 / distortionFractionalResolution;
				const distortionFractionalDelayG1 = (1.0 - distortionFractionalDelay1) / (1.0 + distortionFractionalDelay1); // Inlined version of FilterCoefficients.prototype.allPass1stOrderFractionalDelay
				const distortionFractionalDelayG2 = (1.0 - distortionFractionalDelay2) / (1.0 + distortionFractionalDelay2); // Inlined version of FilterCoefficients.prototype.allPass1stOrderFractionalDelay
				const distortionFractionalDelayG3 = (1.0 - distortionFractionalDelay3) / (1.0 + distortionFractionalDelay3); // Inlined version of FilterCoefficients.prototype.allPass1stOrderFractionalDelay
				const distortionNextOutputWeight1 = Math.cos(Math.PI * distortionFractionalDelay1) * 0.5 + 0.5;
				const distortionNextOutputWeight2 = Math.cos(Math.PI * distortionFractionalDelay2) * 0.5 + 0.5;
				const distortionNextOutputWeight3 = Math.cos(Math.PI * distortionFractionalDelay3) * 0.5 + 0.5;
				const distortionPrevOutputWeight1 = 1.0 - distortionNextOutputWeight1;
				const distortionPrevOutputWeight2 = 1.0 - distortionNextOutputWeight2;
				const distortionPrevOutputWeight3 = 1.0 - distortionNextOutputWeight3;
				
				let distortionFractionalInput1 = +instrumentState.distortionFractionalInput1;
				let distortionFractionalInput2 = +instrumentState.distortionFractionalInput2;
				let distortionFractionalInput3 = +instrumentState.distortionFractionalInput3;
				let distortionPrevInput = +instrumentState.distortionPrevInput;
				let distortionNextOutput = +instrumentState.distortionNextOutput;`;
			}

			if (usesBitcrusher) {
				effectsSource += `
				
				let bitcrusherPrevInput = +instrumentState.bitcrusherPrevInput;
				let bitcrusherCurrentOutput = +instrumentState.bitcrusherCurrentOutput;
				let bitcrusherPhase = +instrumentState.bitcrusherPhase;
				let bitcrusherPhaseDelta = +instrumentState.bitcrusherPhaseDelta;
				const bitcrusherPhaseDeltaScale = +instrumentState.bitcrusherPhaseDeltaScale;
				let bitcrusherScale = +instrumentState.bitcrusherScale;
				const bitcrusherScaleScale = +instrumentState.bitcrusherScaleScale;
				let bitcrusherFoldLevel = +instrumentState.bitcrusherFoldLevel;
				const bitcrusherFoldLevelScale = +instrumentState.bitcrusherFoldLevelScale;`;
			}

			if (usesEqFilter) {
				effectsSource += `
				
				let filters = instrumentState.eqFilters;
				const filterCount = instrumentState.eqFilterCount|0;
				let initialFilterInput1 = +instrumentState.initialEqFilterInput1;
				let initialFilterInput2 = +instrumentState.initialEqFilterInput2;
				const applyFilters = beepbox.Synth.applyFilters;`;
			}

			// The eq filter volume is also used to fade out the instrument state, so always include it.
			effectsSource += `
				
				let eqFilterVolume = +instrumentState.eqFilterVolume;
				const eqFilterVolumeDelta = +instrumentState.eqFilterVolumeDelta;`;

			if (usesPanning) {
				effectsSource += `
				
				const panningMask = synth.panningDelayBufferMask >>> 0;
				const panningDelayLine = instrumentState.panningDelayLine;
				let panningDelayPos = instrumentState.panningDelayPos & panningMask;
				let   panningVolumeL      = +instrumentState.panningVolumeL;
				let   panningVolumeR      = +instrumentState.panningVolumeR;
				const panningVolumeDeltaL = +instrumentState.panningVolumeDeltaL;
				const panningVolumeDeltaR = +instrumentState.panningVolumeDeltaR;
				let   panningOffsetL      = +instrumentState.panningOffsetL;
				let   panningOffsetR      = +instrumentState.panningOffsetR;
				const panningOffsetDeltaL = 1.0 - instrumentState.panningOffsetDeltaL;
				const panningOffsetDeltaR = 1.0 - instrumentState.panningOffsetDeltaR;`;
			}

			if (usesChorus) {
				effectsSource += `
				
				const chorusMask = synth.chorusDelayBufferMask >>> 0;
				const chorusDelayLineL = instrumentState.chorusDelayLineL;
				const chorusDelayLineR = instrumentState.chorusDelayLineR;
				instrumentState.chorusDelayLineDirty = true;
				let chorusDelayPos = instrumentState.chorusDelayPos & chorusMask;
				
				let chorusVoiceMult = +instrumentState.chorusVoiceMult;
				const chorusVoiceMultDelta = +instrumentState.chorusVoiceMultDelta;
				let chorusCombinedMult = +instrumentState.chorusCombinedMult;
				const chorusCombinedMultDelta = +instrumentState.chorusCombinedMultDelta;
				
				const chorusDuration = +beepbox.Config.chorusPeriodSeconds;
				const chorusAngle = Math.PI * 2.0 / (chorusDuration * synth.samplesPerSecond);
				const chorusRange = synth.samplesPerSecond * beepbox.Config.chorusDelayRange;
				const chorusOffset0 = synth.chorusDelayBufferSize - beepbox.Config.chorusDelayOffsets[0][0] * chorusRange;
				const chorusOffset1 = synth.chorusDelayBufferSize - beepbox.Config.chorusDelayOffsets[0][1] * chorusRange;
				const chorusOffset2 = synth.chorusDelayBufferSize - beepbox.Config.chorusDelayOffsets[0][2] * chorusRange;
				const chorusOffset3 = synth.chorusDelayBufferSize - beepbox.Config.chorusDelayOffsets[1][0] * chorusRange;
				const chorusOffset4 = synth.chorusDelayBufferSize - beepbox.Config.chorusDelayOffsets[1][1] * chorusRange;
				const chorusOffset5 = synth.chorusDelayBufferSize - beepbox.Config.chorusDelayOffsets[1][2] * chorusRange;
				let chorusPhase = instrumentState.chorusPhase % (Math.PI * 2.0);
				let chorusTap0Index = chorusDelayPos + chorusOffset0 - chorusRange * Math.sin(chorusPhase + beepbox.Config.chorusPhaseOffsets[0][0]);
				let chorusTap1Index = chorusDelayPos + chorusOffset1 - chorusRange * Math.sin(chorusPhase + beepbox.Config.chorusPhaseOffsets[0][1]);
				let chorusTap2Index = chorusDelayPos + chorusOffset2 - chorusRange * Math.sin(chorusPhase + beepbox.Config.chorusPhaseOffsets[0][2]);
				let chorusTap3Index = chorusDelayPos + chorusOffset3 - chorusRange * Math.sin(chorusPhase + beepbox.Config.chorusPhaseOffsets[1][0]);
				let chorusTap4Index = chorusDelayPos + chorusOffset4 - chorusRange * Math.sin(chorusPhase + beepbox.Config.chorusPhaseOffsets[1][1]);
				let chorusTap5Index = chorusDelayPos + chorusOffset5 - chorusRange * Math.sin(chorusPhase + beepbox.Config.chorusPhaseOffsets[1][2]);
				chorusPhase += chorusAngle * runLength;
				const chorusTap0End = chorusDelayPos + chorusOffset0 - chorusRange * Math.sin(chorusPhase + beepbox.Config.chorusPhaseOffsets[0][0]) + runLength;
				const chorusTap1End = chorusDelayPos + chorusOffset1 - chorusRange * Math.sin(chorusPhase + beepbox.Config.chorusPhaseOffsets[0][1]) + runLength;
				const chorusTap2End = chorusDelayPos + chorusOffset2 - chorusRange * Math.sin(chorusPhase + beepbox.Config.chorusPhaseOffsets[0][2]) + runLength;
				const chorusTap3End = chorusDelayPos + chorusOffset3 - chorusRange * Math.sin(chorusPhase + beepbox.Config.chorusPhaseOffsets[1][0]) + runLength;
				const chorusTap4End = chorusDelayPos + chorusOffset4 - chorusRange * Math.sin(chorusPhase + beepbox.Config.chorusPhaseOffsets[1][1]) + runLength;
				const chorusTap5End = chorusDelayPos + chorusOffset5 - chorusRange * Math.sin(chorusPhase + beepbox.Config.chorusPhaseOffsets[1][2]) + runLength;
				const chorusTap0Delta = (chorusTap0End - chorusTap0Index) / runLength;
				const chorusTap1Delta = (chorusTap1End - chorusTap1Index) / runLength;
				const chorusTap2Delta = (chorusTap2End - chorusTap2Index) / runLength;
				const chorusTap3Delta = (chorusTap3End - chorusTap3Index) / runLength;
				const chorusTap4Delta = (chorusTap4End - chorusTap4Index) / runLength;
				const chorusTap5Delta = (chorusTap5End - chorusTap5Index) / runLength;`;
			}

			if (usesEcho) {
				effectsSource += `
				
				let echoMult = +instrumentState.echoMult;
				const echoMultDelta = +instrumentState.echoMultDelta;
				
				const echoDelayLineL = instrumentState.echoDelayLineL;
				const echoDelayLineR = instrumentState.echoDelayLineR;
				const echoMask = (echoDelayLineL.length - 1) >>> 0;
				instrumentState.echoDelayLineDirty = true;
				
				let echoDelayPos = instrumentState.echoDelayPos & echoMask;
				const echoDelayOffsetStart = (echoDelayLineL.length - instrumentState.echoDelayOffsetStart) & echoMask;
				const echoDelayOffsetEnd   = (echoDelayLineL.length - instrumentState.echoDelayOffsetEnd) & echoMask;
				let echoDelayOffsetRatio = +instrumentState.echoDelayOffsetRatio;
				const echoDelayOffsetRatioDelta = +instrumentState.echoDelayOffsetRatioDelta;
				
				const echoShelfA1 = +instrumentState.echoShelfA1;
				const echoShelfB0 = +instrumentState.echoShelfB0;
				const echoShelfB1 = +instrumentState.echoShelfB1;
				let echoShelfSampleL = +instrumentState.echoShelfSampleL;
				let echoShelfSampleR = +instrumentState.echoShelfSampleR;
				let echoShelfPrevInputL = +instrumentState.echoShelfPrevInputL;
				let echoShelfPrevInputR = +instrumentState.echoShelfPrevInputR;`;
			}

			if (usesReverb) {
				effectsSource += `
				
				const reverbMask = Config.reverbDelayBufferMask >>> 0; //TODO: Dynamic reverb buffer size.
				const reverbDelayLine = instrumentState.reverbDelayLine;
				instrumentState.reverbDelayLineDirty = true;
				let reverbDelayPos = instrumentState.reverbDelayPos & reverbMask;
				
				let reverb = +instrumentState.reverbMult;
				const reverbDelta = +instrumentState.reverbMultDelta;
				
				const reverbShelfA1 = +instrumentState.reverbShelfA1;
				const reverbShelfB0 = +instrumentState.reverbShelfB0;
				const reverbShelfB1 = +instrumentState.reverbShelfB1;
				let reverbShelfSample0 = +instrumentState.reverbShelfSample0;
				let reverbShelfSample1 = +instrumentState.reverbShelfSample1;
				let reverbShelfSample2 = +instrumentState.reverbShelfSample2;
				let reverbShelfSample3 = +instrumentState.reverbShelfSample3;
				let reverbShelfPrevInput0 = +instrumentState.reverbShelfPrevInput0;
				let reverbShelfPrevInput1 = +instrumentState.reverbShelfPrevInput1;
				let reverbShelfPrevInput2 = +instrumentState.reverbShelfPrevInput2;
				let reverbShelfPrevInput3 = +instrumentState.reverbShelfPrevInput3;`;
			}

			effectsSource += `
				
				const stopIndex = bufferIndex + runLength;
				for (let sampleIndex = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
					let sample = tempMonoInstrumentSampleBuffer[sampleIndex];
					tempMonoInstrumentSampleBuffer[sampleIndex] = 0.0;`;

			if (usesDistortion) {
				effectsSource += `
					
					const distortionReverse = 1.0 - distortion;
					const distortionNextInput = sample * distortionDrive;
					sample = distortionNextOutput;
					distortionNextOutput = distortionNextInput / (distortionReverse * Math.abs(distortionNextInput) + distortion);
					distortionFractionalInput1 = distortionFractionalDelayG1 * distortionNextInput + distortionPrevInput - distortionFractionalDelayG1 * distortionFractionalInput1;
					distortionFractionalInput2 = distortionFractionalDelayG2 * distortionNextInput + distortionPrevInput - distortionFractionalDelayG2 * distortionFractionalInput2;
					distortionFractionalInput3 = distortionFractionalDelayG3 * distortionNextInput + distortionPrevInput - distortionFractionalDelayG3 * distortionFractionalInput3;
					const distortionOutput1 = distortionFractionalInput1 / (distortionReverse * Math.abs(distortionFractionalInput1) + distortion);
					const distortionOutput2 = distortionFractionalInput2 / (distortionReverse * Math.abs(distortionFractionalInput2) + distortion);
					const distortionOutput3 = distortionFractionalInput3 / (distortionReverse * Math.abs(distortionFractionalInput3) + distortion);
					distortionNextOutput += distortionOutput1 * distortionNextOutputWeight1 + distortionOutput2 * distortionNextOutputWeight2 + distortionOutput3 * distortionNextOutputWeight3;
					sample += distortionOutput1 * distortionPrevOutputWeight1 + distortionOutput2 * distortionPrevOutputWeight2 + distortionOutput3 * distortionPrevOutputWeight3;
					sample *= distortionOversampleCompensation;
					distortionPrevInput = distortionNextInput;
					distortion += distortionDelta;
					distortionDrive += distortionDriveDelta;`;
			}

			if (usesBitcrusher) {
				effectsSource += `
					
					bitcrusherPhase += bitcrusherPhaseDelta;
					if (bitcrusherPhase < 1.0) {
						bitcrusherPrevInput = sample;
						sample = bitcrusherCurrentOutput;
					} else {
						bitcrusherPhase = bitcrusherPhase % 1.0;
						const ratio = bitcrusherPhase / bitcrusherPhaseDelta;
						
						const lerpedInput = sample + (bitcrusherPrevInput - sample) * ratio;
						bitcrusherPrevInput = sample;
						
						const bitcrusherWrapLevel = bitcrusherFoldLevel * 4.0;
						const wrappedSample = (((lerpedInput + bitcrusherFoldLevel) % bitcrusherWrapLevel) + bitcrusherWrapLevel) % bitcrusherWrapLevel;
						const foldedSample = bitcrusherFoldLevel - Math.abs(bitcrusherFoldLevel * 2.0 - wrappedSample);
						const scaledSample = foldedSample / bitcrusherScale;
						const oldValue = bitcrusherCurrentOutput;
						const newValue = (((scaledSample > 0 ? scaledSample + 1 : scaledSample)|0)-.5) * bitcrusherScale;
						
						sample = oldValue + (newValue - oldValue) * ratio;
						bitcrusherCurrentOutput = newValue;
					}
					bitcrusherPhaseDelta *= bitcrusherPhaseDeltaScale;
					bitcrusherScale *= bitcrusherScaleScale;
					bitcrusherFoldLevel *= bitcrusherFoldLevelScale;`;
			}

			if (usesEqFilter) {
				effectsSource += `
					
					const inputSample = sample;
					sample = applyFilters(inputSample, initialFilterInput1, initialFilterInput2, filterCount, filters);
					initialFilterInput2 = initialFilterInput1;
					initialFilterInput1 = inputSample;`;
			}

			// The eq filter volume is also used to fade out the instrument state, so always include it.
			effectsSource += `
					
					sample *= eqFilterVolume;
					eqFilterVolume += eqFilterVolumeDelta;`;

			if (usesPanning) {
				effectsSource += `
					
					panningDelayLine[panningDelayPos] = sample;
					const panningRatioL  = panningOffsetL % 1;
					const panningRatioR  = panningOffsetR % 1;
					const panningTapLA   = panningDelayLine[(panningOffsetL) & panningMask];
					const panningTapLB   = panningDelayLine[(panningOffsetL + 1) & panningMask];
					const panningTapRA   = panningDelayLine[(panningOffsetR) & panningMask];
					const panningTapRB   = panningDelayLine[(panningOffsetR + 1) & panningMask];
					const panningTapL    = panningTapLA + (panningTapLB - panningTapLA) * panningRatioL;
					const panningTapR    = panningTapRA + (panningTapRB - panningTapRA) * panningRatioR;
					let sampleL = panningTapL * panningVolumeL;
					let sampleR = panningTapR * panningVolumeR;
					panningDelayPos = (panningDelayPos + 1) & panningMask;
					panningVolumeL += panningVolumeDeltaL;
					panningVolumeR += panningVolumeDeltaR;
					panningOffsetL += panningOffsetDeltaL;
					panningOffsetR += panningOffsetDeltaR;`;
			} else {
				effectsSource += `
					
					let sampleL = sample;
					let sampleR = sample;`;
			}

			if (usesChorus) {
				effectsSource += `
					
					const chorusTap0Ratio = chorusTap0Index % 1;
					const chorusTap1Ratio = chorusTap1Index % 1;
					const chorusTap2Ratio = chorusTap2Index % 1;
					const chorusTap3Ratio = chorusTap3Index % 1;
					const chorusTap4Ratio = chorusTap4Index % 1;
					const chorusTap5Ratio = chorusTap5Index % 1;
					const chorusTap0A = chorusDelayLineL[(chorusTap0Index) & chorusMask];
					const chorusTap0B = chorusDelayLineL[(chorusTap0Index + 1) & chorusMask];
					const chorusTap1A = chorusDelayLineL[(chorusTap1Index) & chorusMask];
					const chorusTap1B = chorusDelayLineL[(chorusTap1Index + 1) & chorusMask];
					const chorusTap2A = chorusDelayLineL[(chorusTap2Index) & chorusMask];
					const chorusTap2B = chorusDelayLineL[(chorusTap2Index + 1) & chorusMask];
					const chorusTap3A = chorusDelayLineR[(chorusTap3Index) & chorusMask];
					const chorusTap3B = chorusDelayLineR[(chorusTap3Index + 1) & chorusMask];
					const chorusTap4A = chorusDelayLineR[(chorusTap4Index) & chorusMask];
					const chorusTap4B = chorusDelayLineR[(chorusTap4Index + 1) & chorusMask];
					const chorusTap5A = chorusDelayLineR[(chorusTap5Index) & chorusMask];
					const chorusTap5B = chorusDelayLineR[(chorusTap5Index + 1) & chorusMask];
					const chorusTap0 = chorusTap0A + (chorusTap0B - chorusTap0A) * chorusTap0Ratio;
					const chorusTap1 = chorusTap1A + (chorusTap1B - chorusTap1A) * chorusTap1Ratio;
					const chorusTap2 = chorusTap2A + (chorusTap2B - chorusTap2A) * chorusTap2Ratio;
					const chorusTap3 = chorusTap3A + (chorusTap3B - chorusTap3A) * chorusTap3Ratio;
					const chorusTap4 = chorusTap4A + (chorusTap4B - chorusTap4A) * chorusTap4Ratio;
					const chorusTap5 = chorusTap5A + (chorusTap5B - chorusTap5A) * chorusTap5Ratio;
					chorusDelayLineL[chorusDelayPos] = sampleL * delayInputMult;
					chorusDelayLineR[chorusDelayPos] = sampleR * delayInputMult;
					sampleL = chorusCombinedMult * (sampleL + chorusVoiceMult * (chorusTap1 - chorusTap0 - chorusTap2));
					sampleR = chorusCombinedMult * (sampleR + chorusVoiceMult * (chorusTap4 - chorusTap3 - chorusTap5));
					chorusDelayPos = (chorusDelayPos + 1) & chorusMask;
					chorusTap0Index += chorusTap0Delta;
					chorusTap1Index += chorusTap1Delta;
					chorusTap2Index += chorusTap2Delta;
					chorusTap3Index += chorusTap3Delta;
					chorusTap4Index += chorusTap4Delta;
					chorusTap5Index += chorusTap5Delta;
					chorusVoiceMult += chorusVoiceMultDelta;
					chorusCombinedMult += chorusCombinedMultDelta;`;
			}

			if (usesEcho) {
				effectsSource += `
					
					const echoTapStartIndex = (echoDelayPos + echoDelayOffsetStart) & echoMask;
					const echoTapEndIndex   = (echoDelayPos + echoDelayOffsetEnd  ) & echoMask;
					const echoTapStartL = echoDelayLineL[echoTapStartIndex];
					const echoTapEndL   = echoDelayLineL[echoTapEndIndex];
					const echoTapStartR = echoDelayLineR[echoTapStartIndex];
					const echoTapEndR   = echoDelayLineR[echoTapEndIndex];
					const echoTapL = (echoTapStartL + (echoTapEndL - echoTapStartL) * echoDelayOffsetRatio) * echoMult;
					const echoTapR = (echoTapStartR + (echoTapEndR - echoTapStartR) * echoDelayOffsetRatio) * echoMult;
					
					echoShelfSampleL = echoShelfB0 * echoTapL + echoShelfB1 * echoShelfPrevInputL - echoShelfA1 * echoShelfSampleL;
					echoShelfSampleR = echoShelfB0 * echoTapR + echoShelfB1 * echoShelfPrevInputR - echoShelfA1 * echoShelfSampleR;
					echoShelfPrevInputL = echoTapL;
					echoShelfPrevInputR = echoTapR;
					sampleL += echoShelfSampleL;
					sampleR += echoShelfSampleR;
					
					echoDelayLineL[echoDelayPos] = sampleL * delayInputMult;
					echoDelayLineR[echoDelayPos] = sampleR * delayInputMult;
					echoDelayPos = (echoDelayPos + 1) & echoMask;
					echoDelayOffsetRatio += echoDelayOffsetRatioDelta;
					echoMult += echoMultDelta;
                    `;
			}

			if (usesReverb) {
				effectsSource += `
					
					// Reverb, implemented using a feedback delay network with a Hadamard matrix and lowpass filters.
					// good ratios:    0.555235 + 0.618033 + 0.818 +   1.0 = 2.991268
					// Delay lengths:  3041     + 3385     + 4481  +  5477 = 16384 = 2^14
					// Buffer offsets: 3041    -> 6426   -> 10907 -> 16384
					const reverbDelayPos1 = (reverbDelayPos +  3041) & reverbMask;
					const reverbDelayPos2 = (reverbDelayPos +  6426) & reverbMask;
					const reverbDelayPos3 = (reverbDelayPos + 10907) & reverbMask;
					const reverbSample0 = (reverbDelayLine[reverbDelayPos]);
					const reverbSample1 = reverbDelayLine[reverbDelayPos1];
					const reverbSample2 = reverbDelayLine[reverbDelayPos2];
					const reverbSample3 = reverbDelayLine[reverbDelayPos3];
					const reverbTemp0 = -(reverbSample0 + sampleL) + reverbSample1;
					const reverbTemp1 = -(reverbSample0 + sampleR) - reverbSample1;
					const reverbTemp2 = -reverbSample2 + reverbSample3;
					const reverbTemp3 = -reverbSample2 - reverbSample3;
					const reverbShelfInput0 = (reverbTemp0 + reverbTemp2) * reverb;
					const reverbShelfInput1 = (reverbTemp1 + reverbTemp3) * reverb;
					const reverbShelfInput2 = (reverbTemp0 - reverbTemp2) * reverb;
					const reverbShelfInput3 = (reverbTemp1 - reverbTemp3) * reverb;
					reverbShelfSample0 = reverbShelfB0 * reverbShelfInput0 + reverbShelfB1 * reverbShelfPrevInput0 - reverbShelfA1 * reverbShelfSample0;
					reverbShelfSample1 = reverbShelfB0 * reverbShelfInput1 + reverbShelfB1 * reverbShelfPrevInput1 - reverbShelfA1 * reverbShelfSample1;
					reverbShelfSample2 = reverbShelfB0 * reverbShelfInput2 + reverbShelfB1 * reverbShelfPrevInput2 - reverbShelfA1 * reverbShelfSample2;
					reverbShelfSample3 = reverbShelfB0 * reverbShelfInput3 + reverbShelfB1 * reverbShelfPrevInput3 - reverbShelfA1 * reverbShelfSample3;
					reverbShelfPrevInput0 = reverbShelfInput0;
					reverbShelfPrevInput1 = reverbShelfInput1;
					reverbShelfPrevInput2 = reverbShelfInput2;
					reverbShelfPrevInput3 = reverbShelfInput3;
					reverbDelayLine[reverbDelayPos1] = reverbShelfSample0 * delayInputMult;
					reverbDelayLine[reverbDelayPos2] = reverbShelfSample1 * delayInputMult;
					reverbDelayLine[reverbDelayPos3] = reverbShelfSample2 * delayInputMult;
					reverbDelayLine[reverbDelayPos ] = reverbShelfSample3 * delayInputMult;
					reverbDelayPos = (reverbDelayPos + 1) & reverbMask;
					sampleL += reverbSample1 + reverbSample2 + reverbSample3;
					sampleR += reverbSample0 + reverbSample2 - reverbSample3;
					reverb += reverbDelta;`;
			}

			effectsSource += `
					
					outputDataL[sampleIndex] += sampleL * mixVolume;
					outputDataR[sampleIndex] += sampleR * mixVolume;
					mixVolume += mixVolumeDelta;`;

			if (usesDelays) {
				effectsSource += `
					
					delayInputMult += delayInputMultDelta;`;
			}

			effectsSource += `
				}
				
				instrumentState.mixVolume = mixVolume;
				instrumentState.eqFilterVolume = eqFilterVolume;
				
				// Avoid persistent denormal or NaN values in the delay buffers and filter history.
				const epsilon = (1.0e-24);`;

			if (usesDelays) {
				effectsSource += `
				
				instrumentState.delayInputMult = delayInputMult;`;
			}

			if (usesDistortion) {
				effectsSource += `
				
				instrumentState.distortion = distortion;
				instrumentState.distortionDrive = distortionDrive;
				
				if (!Number.isFinite(distortionFractionalInput1) || Math.abs(distortionFractionalInput1) < epsilon) distortionFractionalInput1 = 0.0;
				if (!Number.isFinite(distortionFractionalInput2) || Math.abs(distortionFractionalInput2) < epsilon) distortionFractionalInput2 = 0.0;
				if (!Number.isFinite(distortionFractionalInput3) || Math.abs(distortionFractionalInput3) < epsilon) distortionFractionalInput3 = 0.0;
				if (!Number.isFinite(distortionPrevInput) || Math.abs(distortionPrevInput) < epsilon) distortionPrevInput = 0.0;
				if (!Number.isFinite(distortionNextOutput) || Math.abs(distortionNextOutput) < epsilon) distortionNextOutput = 0.0;
				
				instrumentState.distortionFractionalInput1 = distortionFractionalInput1;
				instrumentState.distortionFractionalInput2 = distortionFractionalInput2;
				instrumentState.distortionFractionalInput3 = distortionFractionalInput3;
				instrumentState.distortionPrevInput = distortionPrevInput;
				instrumentState.distortionNextOutput = distortionNextOutput;`;
			}

			if (usesBitcrusher) {
				effectsSource += `
					
				if (Math.abs(bitcrusherPrevInput) < epsilon) bitcrusherPrevInput = 0.0;
				if (Math.abs(bitcrusherCurrentOutput) < epsilon) bitcrusherCurrentOutput = 0.0;
				instrumentState.bitcrusherPrevInput = bitcrusherPrevInput;
				instrumentState.bitcrusherCurrentOutput = bitcrusherCurrentOutput;
				instrumentState.bitcrusherPhase = bitcrusherPhase;
				instrumentState.bitcrusherPhaseDelta = bitcrusherPhaseDelta;
				instrumentState.bitcrusherScale = bitcrusherScale;
				instrumentState.bitcrusherFoldLevel = bitcrusherFoldLevel;`;
			}

			if (usesEqFilter) {
				effectsSource += `
					
				synth.sanitizeFilters(filters);
				// The filter input here is downstream from another filter so we
				// better make sure it's safe too.
				if (!(initialFilterInput1 < 100) || !(initialFilterInput2 < 100)) {
					initialFilterInput1 = 0.0;
					initialFilterInput2 = 0.0;
				}
				if (Math.abs(initialFilterInput1) < epsilon) initialFilterInput1 = 0.0;
				if (Math.abs(initialFilterInput2) < epsilon) initialFilterInput2 = 0.0;
				instrumentState.initialEqFilterInput1 = initialFilterInput1;
				instrumentState.initialEqFilterInput2 = initialFilterInput2;`;
			}

			if (usesPanning) {
				effectsSource += `
				
				beepbox.Synth.sanitizeDelayLine(panningDelayLine, panningDelayPos, panningMask);
				instrumentState.panningDelayPos = panningDelayPos;
				instrumentState.panningVolumeL = panningVolumeL;
				instrumentState.panningVolumeR = panningVolumeR;
				instrumentState.panningOffsetL = panningOffsetL;
				instrumentState.panningOffsetR = panningOffsetR;`;
			}

			if (usesChorus) {
				effectsSource += `
				
				beepbox.Synth.sanitizeDelayLine(chorusDelayLineL, chorusDelayPos, chorusMask);
				beepbox.Synth.sanitizeDelayLine(chorusDelayLineR, chorusDelayPos, chorusMask);
				instrumentState.chorusPhase = chorusPhase;
				instrumentState.chorusDelayPos = chorusDelayPos;
				instrumentState.chorusVoiceMult = chorusVoiceMult;
				instrumentState.chorusCombinedMult = chorusCombinedMult;`;
			}

			if (usesEcho) {
				effectsSource += `
				
				beepbox.Synth.sanitizeDelayLine(echoDelayLineL, echoDelayPos, echoMask);
				beepbox.Synth.sanitizeDelayLine(echoDelayLineR, echoDelayPos, echoMask);
				instrumentState.echoDelayPos = echoDelayPos;
				instrumentState.echoMult = echoMult;
				instrumentState.echoDelayOffsetRatio = echoDelayOffsetRatio;
				
				if (!Number.isFinite(echoShelfSampleL) || Math.abs(echoShelfSampleL) < epsilon) echoShelfSampleL = 0.0;
				if (!Number.isFinite(echoShelfSampleR) || Math.abs(echoShelfSampleR) < epsilon) echoShelfSampleR = 0.0;
				if (!Number.isFinite(echoShelfPrevInputL) || Math.abs(echoShelfPrevInputL) < epsilon) echoShelfPrevInputL = 0.0;
				if (!Number.isFinite(echoShelfPrevInputR) || Math.abs(echoShelfPrevInputR) < epsilon) echoShelfPrevInputR = 0.0;
				instrumentState.echoShelfSampleL = echoShelfSampleL;
				instrumentState.echoShelfSampleR = echoShelfSampleR;
				instrumentState.echoShelfPrevInputL = echoShelfPrevInputL;
				instrumentState.echoShelfPrevInputR = echoShelfPrevInputR;`;
			}

			if (usesReverb) {
				effectsSource += `
				
				beepbox.Synth.sanitizeDelayLine(reverbDelayLine, reverbDelayPos        , reverbMask);
				beepbox.Synth.sanitizeDelayLine(reverbDelayLine, reverbDelayPos +  3041, reverbMask);
				beepbox.Synth.sanitizeDelayLine(reverbDelayLine, reverbDelayPos +  6426, reverbMask);
				beepbox.Synth.sanitizeDelayLine(reverbDelayLine, reverbDelayPos + 10907, reverbMask);
				instrumentState.reverbDelayPos = reverbDelayPos;
				instrumentState.reverbMult = reverb;
				
				if (!Number.isFinite(reverbShelfSample0) || Math.abs(reverbShelfSample0) < epsilon) reverbShelfSample0 = 0.0;
				if (!Number.isFinite(reverbShelfSample1) || Math.abs(reverbShelfSample1) < epsilon) reverbShelfSample1 = 0.0;
				if (!Number.isFinite(reverbShelfSample2) || Math.abs(reverbShelfSample2) < epsilon) reverbShelfSample2 = 0.0;
				if (!Number.isFinite(reverbShelfSample3) || Math.abs(reverbShelfSample3) < epsilon) reverbShelfSample3 = 0.0;
				if (!Number.isFinite(reverbShelfPrevInput0) || Math.abs(reverbShelfPrevInput0) < epsilon) reverbShelfPrevInput0 = 0.0;
				if (!Number.isFinite(reverbShelfPrevInput1) || Math.abs(reverbShelfPrevInput1) < epsilon) reverbShelfPrevInput1 = 0.0;
				if (!Number.isFinite(reverbShelfPrevInput2) || Math.abs(reverbShelfPrevInput2) < epsilon) reverbShelfPrevInput2 = 0.0;
				if (!Number.isFinite(reverbShelfPrevInput3) || Math.abs(reverbShelfPrevInput3) < epsilon) reverbShelfPrevInput3 = 0.0;
				instrumentState.reverbShelfSample0 = reverbShelfSample0;
				instrumentState.reverbShelfSample1 = reverbShelfSample1;
				instrumentState.reverbShelfSample2 = reverbShelfSample2;
				instrumentState.reverbShelfSample3 = reverbShelfSample3;
				instrumentState.reverbShelfPrevInput0 = reverbShelfPrevInput0;
				instrumentState.reverbShelfPrevInput1 = reverbShelfPrevInput1;
				instrumentState.reverbShelfPrevInput2 = reverbShelfPrevInput2;
				instrumentState.reverbShelfPrevInput3 = reverbShelfPrevInput3;`;
			}

			//console.log(effectsSource);
			effectsFunction = new Function(
				"synth",
				"outputDataL",
				"outputDataR",
				"bufferIndex",
				"runLength",
				"instrumentState",
				effectsSource
			);
			Synth.effectsFunctionCache[signature] = effectsFunction;
		}

		effectsFunction(synth, outputDataL, outputDataR, bufferIndex, runLength, instrumentState);
	}

	private static pulseWidthSynth(
		synth: Synth,
		bufferIndex: number,
		roundedSamplesPerTick: number,
		tone: Tone,
		instrument: Instrument
	): void {
		const data: Float32Array = synth.tempMonoInstrumentSampleBuffer!;

		let phaseDelta: number = tone.phaseDeltas[0];
		const phaseDeltaScale: number = +tone.phaseDeltaScales[0];
		let expression: number = +tone.expression;
		const expressionDelta: number = +tone.expressionDelta;
		let phase: number = tone.phases[0] % 1;

		let pulseWidth: number = tone.pulseWidth;
		const pulseWidthDelta: number = tone.pulseWidthDelta;

		const filters: DynamicBiquadFilter[] = tone.noteFilters;
		const filterCount: number = tone.noteFilterCount | 0;
		let initialFilterInput1: number = +tone.initialNoteFilterInput1;
		let initialFilterInput2: number = +tone.initialNoteFilterInput2;
		const applyFilters: Function = Synth.applyFilters;

		const stopIndex: number = bufferIndex + roundedSamplesPerTick;
		for (let sampleIndex: number = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
			const sawPhaseA: number = phase % 1;
			const sawPhaseB: number = (phase + pulseWidth) % 1;

			let pulseWave: number = sawPhaseB - sawPhaseA;

			// This is a PolyBLEP, which smooths out discontinuities at any frequency to reduce aliasing.
			if (!instrument.aliases) {
				if (sawPhaseA < phaseDelta) {
					var t = sawPhaseA / phaseDelta;
					pulseWave += (t + t - t * t - 1) * 0.5;
				} else if (sawPhaseA > 1.0 - phaseDelta) {
					var t = (sawPhaseA - 1.0) / phaseDelta;
					pulseWave += (t + t + t * t + 1) * 0.5;
				}
				if (sawPhaseB < phaseDelta) {
					var t = sawPhaseB / phaseDelta;
					pulseWave -= (t + t - t * t - 1) * 0.5;
				} else if (sawPhaseB > 1.0 - phaseDelta) {
					var t = (sawPhaseB - 1.0) / phaseDelta;
					pulseWave -= (t + t + t * t + 1) * 0.5;
				}
			}

			const inputSample: number = pulseWave;
			const sample: number = applyFilters(
				inputSample,
				initialFilterInput1,
				initialFilterInput2,
				filterCount,
				filters
			);
			initialFilterInput2 = initialFilterInput1;
			initialFilterInput1 = inputSample;

			phase += phaseDelta;
			phaseDelta *= phaseDeltaScale;
			pulseWidth += pulseWidthDelta;

			const output: number = sample * expression;
			expression += expressionDelta;

			data[sampleIndex] += output;
		}

		tone.phases[0] = phase;
		tone.phaseDeltas[0] = phaseDelta;
		tone.expression = expression;
		tone.pulseWidth = pulseWidth;

		synth.sanitizeFilters(filters);
		tone.initialNoteFilterInput1 = initialFilterInput1;
		tone.initialNoteFilterInput2 = initialFilterInput2;
	}

	private static fmSourceTemplate: string[] = (
		`
		const data = synth.tempMonoInstrumentSampleBuffer;
		const sineWave = beepbox.Config.sineWave;
			
		// I'm adding 1000 to the phase to ensure that it's never negative even when modulated by other waves because negative numbers don't work with the modulus operator very well.
		let operator#Phase       = +((tone.phases[#] % 1) + 1000) * ` +
		Config.sineWaveLength +
		`;
		let operator#PhaseDelta  = +tone.phaseDeltas[#] * ` +
		Config.sineWaveLength +
		`;
		let operator#PhaseDeltaScale = +tone.phaseDeltaScales[#];
		let operator#OutputMult  = +tone.operatorExpressions[#];
		const operator#OutputDelta = +tone.operatorExpressionDeltas[#];
		let operator#Output      = +tone.feedbackOutputs[#];
        const operator#Wave      = tone.operatorWaves[#].samples;
		let feedbackMult         = +tone.feedbackMult;
		const feedbackDelta        = +tone.feedbackDelta;
        let expression = +tone.expression;
		const expressionDelta = +tone.expressionDelta;
		
		const filters = tone.noteFilters;
		const filterCount = tone.noteFilterCount|0;
		let initialFilterInput1 = +tone.initialNoteFilterInput1;
		let initialFilterInput2 = +tone.initialNoteFilterInput2;
		const applyFilters = beepbox.Synth.applyFilters;
		
		const stopIndex = bufferIndex + roundedSamplesPerTick;
		for (let sampleIndex = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
				// INSERT OPERATOR COMPUTATION HERE
				const fmOutput = (/*operator#Scaled*/); // CARRIER OUTPUTS
				
			const inputSample = fmOutput;
			const sample = applyFilters(inputSample, initialFilterInput1, initialFilterInput2, filterCount, filters);
			initialFilterInput2 = initialFilterInput1;
			initialFilterInput1 = inputSample;
				
				feedbackMult += feedbackDelta;
				operator#OutputMult += operator#OutputDelta;
				operator#Phase += operator#PhaseDelta;
			operator#PhaseDelta *= operator#PhaseDeltaScale;
			
			const output = sample * expression;
			expression += expressionDelta;

			data[sampleIndex] += output;
			}
			
			tone.phases[#] = operator#Phase / ` +
		Config.sineWaveLength +
		`;
			tone.phaseDeltas[#] = operator#PhaseDelta / ` +
		Config.sineWaveLength +
		`;
			tone.operatorExpressions[#] = operator#OutputMult;
		    tone.feedbackOutputs[#] = operator#Output;
		    tone.feedbackMult = feedbackMult;
		    tone.expression = expression;
			
		synth.sanitizeFilters(filters);
		tone.initialNoteFilterInput1 = initialFilterInput1;
		tone.initialNoteFilterInput2 = initialFilterInput2;
		`
	).split("\n");

	private static operatorSourceTemplate: string[] = (
		`
				const operator#PhaseMix = operator#Phase/* + operator@Scaled*/;
				const operator#PhaseInt = operator#PhaseMix|0;
				const operator#Index    = operator#PhaseInt & ` +
		Config.sineWaveMask +
		`;
                const operator#Sample   = operator#Wave[operator#Index];
                operator#Output         = operator#Sample + (operator#Wave[operator#Index + 1] - operator#Sample) * (operator#PhaseMix - operator#PhaseInt);
				const operator#Scaled   = operator#OutputMult * operator#Output;
		`
	).split("\n");

	private static noiseSynth(
		synth: Synth,
		bufferIndex: number,
		runLength: number,
		tone: Tone,
		instrumentState: InstrumentState
	): void {
		const data: Float32Array = synth.tempMonoInstrumentSampleBuffer!;
		const wave: Float32Array = instrumentState.wave!;
		let phaseDelta: number = +tone.phaseDeltas[0];
		const phaseDeltaScale: number = +tone.phaseDeltaScales[0];
		let expression: number = +tone.expression;
		const expressionDelta: number = +tone.expressionDelta;
		let phase: number = (tone.phases[0] % 1) * Config.chipNoiseLength;
		if (tone.phases[0] == 0) {
			// Zero phase means the tone was reset, just give noise a random start phase instead.
			phase = Math.random() * Config.chipNoiseLength;
		}
		const phaseMask: number = Config.chipNoiseLength - 1;
		let noiseSample: number = +tone.noiseSample;

		const filters: DynamicBiquadFilter[] = tone.noteFilters;
		const filterCount: number = tone.noteFilterCount | 0;
		let initialFilterInput1: number = +tone.initialNoteFilterInput1;
		let initialFilterInput2: number = +tone.initialNoteFilterInput2;
		const applyFilters: Function = Synth.applyFilters;

		// This is for a "legacy" style simplified 1st order lowpass filter with
		// a cutoff frequency that is relative to the tone's fundamental frequency.
		const pitchRelativefilter: number = Math.min(1.0, phaseDelta * instrumentState.noisePitchFilterMult);

		const stopIndex: number = bufferIndex + runLength;
		for (let sampleIndex: number = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
			const waveSample: number = wave[phase & phaseMask];

			noiseSample += (waveSample - noiseSample) * pitchRelativefilter;

			const inputSample: number = noiseSample;
			const sample: number = applyFilters(
				inputSample,
				initialFilterInput1,
				initialFilterInput2,
				filterCount,
				filters
			);
			initialFilterInput2 = initialFilterInput1;
			initialFilterInput1 = inputSample;

			phase += phaseDelta;
			phaseDelta *= phaseDeltaScale;

			const output: number = sample * expression;
			expression += expressionDelta;

			data[sampleIndex] += output;
		}

		tone.phases[0] = phase / Config.chipNoiseLength;
		tone.phaseDeltas[0] = phaseDelta;
		tone.expression = expression;
		tone.noiseSample = noiseSample;

		synth.sanitizeFilters(filters);
		tone.initialNoteFilterInput1 = initialFilterInput1;
		tone.initialNoteFilterInput2 = initialFilterInput2;
	}

	private static spectrumSynth(
		synth: Synth,
		bufferIndex: number,
		runLength: number,
		tone: Tone,
		instrumentState: InstrumentState
	): void {
		const data: Float32Array = synth.tempMonoInstrumentSampleBuffer!;
		const wave: Float32Array = instrumentState.wave!;
		const samplesInPeriod: number = 1 << 7;
		let phaseDelta: number = tone.phaseDeltas[0] * samplesInPeriod;
		const phaseDeltaScale: number = +tone.phaseDeltaScales[0];
		let expression: number = +tone.expression;
		const expressionDelta: number = +tone.expressionDelta;
		let noiseSample: number = +tone.noiseSample;

		const filters: DynamicBiquadFilter[] = tone.noteFilters;
		const filterCount: number = tone.noteFilterCount | 0;
		let initialFilterInput1: number = +tone.initialNoteFilterInput1;
		let initialFilterInput2: number = +tone.initialNoteFilterInput2;
		const applyFilters: Function = Synth.applyFilters;

		let phase: number = (tone.phases[0] % 1) * Config.spectrumNoiseLength;
		// Zero phase means the tone was reset, just give noise a random start phase instead.
		if (tone.phases[0] == 0) phase = Synth.findRandomZeroCrossing(wave, Config.spectrumNoiseLength) + phaseDelta;
		const phaseMask: number = Config.spectrumNoiseLength - 1;

		// This is for a "legacy" style simplified 1st order lowpass filter with
		// a cutoff frequency that is relative to the tone's fundamental frequency.
		const pitchRelativefilter: number = Math.min(1.0, phaseDelta);

		const stopIndex: number = bufferIndex + runLength;
		for (let sampleIndex: number = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
			const phaseInt: number = phase | 0;
			const index: number = phaseInt & phaseMask;
			let waveSample: number = wave[index];
			const phaseRatio: number = phase - phaseInt;
			waveSample += (wave[index + 1] - waveSample) * phaseRatio;

			noiseSample += (waveSample - noiseSample) * pitchRelativefilter;

			const inputSample: number = noiseSample;
			const sample: number = applyFilters(
				inputSample,
				initialFilterInput1,
				initialFilterInput2,
				filterCount,
				filters
			);
			initialFilterInput2 = initialFilterInput1;
			initialFilterInput1 = inputSample;

			phase += phaseDelta;
			phaseDelta *= phaseDeltaScale;

			const output: number = sample * expression;
			expression += expressionDelta;

			data[sampleIndex] += output;
		}

		tone.phases[0] = phase / Config.spectrumNoiseLength;
		tone.phaseDeltas[0] = phaseDelta / samplesInPeriod;
		tone.expression = expression;
		tone.noiseSample = noiseSample;

		synth.sanitizeFilters(filters);
		tone.initialNoteFilterInput1 = initialFilterInput1;
		tone.initialNoteFilterInput2 = initialFilterInput2;
	}

	private static drumsetSynth(
		synth: Synth,
		bufferIndex: number,
		runLength: number,
		tone: Tone,
		instrumentState: InstrumentState
	): void {
		const data: Float32Array = synth.tempMonoInstrumentSampleBuffer!;
		let wave: Float32Array = instrumentState.getDrumsetWave(tone.drumsetPitch!);
		const referenceDelta: number = InstrumentState.drumsetIndexReferenceDelta(tone.drumsetPitch!);
		let phaseDelta: number = tone.phaseDeltas[0] / referenceDelta;
		const phaseDeltaScale: number = +tone.phaseDeltaScales[0];
		let expression: number = +tone.expression;
		const expressionDelta: number = +tone.expressionDelta;

		const filters: DynamicBiquadFilter[] = tone.noteFilters;
		const filterCount: number = tone.noteFilterCount | 0;
		let initialFilterInput1: number = +tone.initialNoteFilterInput1;
		let initialFilterInput2: number = +tone.initialNoteFilterInput2;
		const applyFilters: Function = Synth.applyFilters;

		let phase: number = (tone.phases[0] % 1) * Config.spectrumNoiseLength;
		// Zero phase means the tone was reset, just give noise a random start phase instead.
		if (tone.phases[0] == 0) phase = Synth.findRandomZeroCrossing(wave, Config.spectrumNoiseLength) + phaseDelta;
		const phaseMask: number = Config.spectrumNoiseLength - 1;

		const stopIndex: number = bufferIndex + runLength;
		for (let sampleIndex: number = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
			const phaseInt: number = phase | 0;
			const index: number = phaseInt & phaseMask;
			let noiseSample: number = wave[index];
			const phaseRatio: number = phase - phaseInt;
			noiseSample += (wave[index + 1] - noiseSample) * phaseRatio;

			const inputSample: number = noiseSample;
			const sample: number = applyFilters(
				inputSample,
				initialFilterInput1,
				initialFilterInput2,
				filterCount,
				filters
			);
			initialFilterInput2 = initialFilterInput1;
			initialFilterInput1 = inputSample;

			phase += phaseDelta;
			phaseDelta *= phaseDeltaScale;

			const output: number = sample * expression;
			expression += expressionDelta;

			data[sampleIndex] += output;
		}

		tone.phases[0] = phase / Config.spectrumNoiseLength;
		tone.phaseDeltas[0] = phaseDelta * referenceDelta;
		tone.expression = expression;

		synth.sanitizeFilters(filters);
		tone.initialNoteFilterInput1 = initialFilterInput1;
		tone.initialNoteFilterInput2 = initialFilterInput2;
	}

	private static modSynth(
		synth: Synth,
		stereoBufferIndex: number,
		roundedSamplesPerTick: number,
		tone: Tone,
		instrument: Instrument
	): void {
		// Note: present modulator value is tone.expressionStarts[0].

		if (!synth.song) return;

		let mod: number = Config.modCount - 1 - tone.pitches[0];

		// Flagged as invalid because unused by current settings, skip
		if (instrument.invalidModulators[mod]) return;

		let setting: number = instrument.modulators[mod];

		// Generate list of used instruments
		let usedInstruments: number[] = [];
		if (Config.modulators[instrument.modulators[mod]].forSong) {
			// Instrument doesn't matter for song, just push a random index to run the modsynth once
			usedInstruments.push(0);
		} else {
			// All
			if (instrument.modInstruments[mod] == synth.song.channels[instrument.modChannels[mod]].instruments.length) {
				for (let i: number = 0; i < synth.song.channels[instrument.modChannels[mod]].instruments.length; i++) {
					usedInstruments.push(i);
				}
			}
			// Active
			else if (
				instrument.modInstruments[mod] > synth.song.channels[instrument.modChannels[mod]].instruments.length
			) {
				if (synth.song.getPattern(instrument.modChannels[mod], synth.bar) != null)
					usedInstruments = synth.song.getPattern(instrument.modChannels[mod], synth.bar)!.instruments;
			} else {
				usedInstruments.push(instrument.modInstruments[mod]);
			}
		}

		for (let instrumentIndex: number = 0; instrumentIndex < usedInstruments.length; instrumentIndex++) {
			synth.setModValue(
				tone.expression,
				tone.expression + tone.expressionDelta,
				mod,
				instrument.modChannels[mod],
				usedInstruments[instrumentIndex],
				setting
			);

			// Reset arps, but only at the start of the note
			if (
				setting == Config.modulators.dictionary["reset arp"].index &&
				synth.tick == 0 &&
				tone.noteStartPart == synth.beat * Config.partsPerBeat + synth.part
			) {
				synth.song.channels[instrument.modChannels[mod]].instruments[
					usedInstruments[instrumentIndex]
				].arpTime = 0;
			}
			// Denote next bar skip
			else if (setting == Config.modulators.dictionary["next bar"].index) {
				synth.wantToSkip = true;
			}
			// Extra info for eq filter target needs to be set as well
			else if (setting == Config.modulators.dictionary["eq filter"].index) {
				const tgtInstrument =
					synth.song.channels[instrument.modChannels[mod]].instruments[usedInstruments[instrumentIndex]];

				if (!tgtInstrument.eqFilterType) {
					let dotTarget = instrument.modFilterTypes[mod] | 0;

					if (dotTarget == 0) {
						// Morph. Figure out the target filter's X/Y coords for this point. If no point exists with this index, or point types don't match, do lerp-out for this point and lerp-in of a new point

						let pinIdx: number = 0;
						const currentPart: number = synth.getTicksIntoBar() / Config.ticksPerPart;
						while (tone.note!.start + tone.note!.pins[pinIdx].time <= currentPart) pinIdx++;
						// 0 to 1 based on distance to next morph
						//let lerpStartRatio: number = (currentPart - tone.note!.pins[pinIdx - 1].time) / (tone.note!.pins[pinIdx].time - tone.note!.pins[pinIdx - 1].time);
						let lerpEndRatio: number =
							(currentPart -
								tone.note!.start +
								(roundedSamplesPerTick / (synth.getSamplesPerTick() * Config.ticksPerPart)) *
									Config.ticksPerPart -
								tone.note!.pins[pinIdx - 1].time) /
							(tone.note!.pins[pinIdx].time - tone.note!.pins[pinIdx - 1].time);

						// Compute the new settings to go to.
						if (
							tgtInstrument.eqSubFilters[tone.note!.pins[pinIdx - 1].size] != null ||
							tgtInstrument.eqSubFilters[tone.note!.pins[pinIdx].size] != null
						) {
							tgtInstrument.tmpEqFilterEnd = FilterSettings.lerpFilters(
								tgtInstrument.eqSubFilters[tone.note!.pins[pinIdx - 1].size]!,
								tgtInstrument.eqSubFilters[tone.note!.pins[pinIdx].size]!,
								lerpEndRatio
							);
						} else {
							// No mutation will occur to the filter object so we can safely return it without copying
							tgtInstrument.tmpEqFilterEnd = tgtInstrument.eqFilter;
						}
					} // Target (1 is dot 1 X, 2 is dot 1 Y, etc.)
					else {
						// Since we are directly manipulating the filter, make sure it is a new one and not an actual one of the instrument's filters
						for (let i: number = 0; i < Config.filterMorphCount; i++) {
							if (
								tgtInstrument.tmpEqFilterEnd == tgtInstrument.eqSubFilters[i] &&
								tgtInstrument.tmpEqFilterEnd != null
							) {
								tgtInstrument.tmpEqFilterEnd = new FilterSettings();
								tgtInstrument.tmpEqFilterEnd.fromJsonObject(
									tgtInstrument.eqSubFilters[i]!.toJsonObject()
								);
							}
						}
						if (tgtInstrument.tmpEqFilterEnd == null) {
							tgtInstrument.tmpEqFilterEnd = new FilterSettings();
							tgtInstrument.tmpEqFilterEnd.fromJsonObject(tgtInstrument.eqFilter.toJsonObject());
						}

						if (tgtInstrument.tmpEqFilterEnd.controlPointCount > Math.floor((dotTarget - 1) / 2)) {
							if (dotTarget % 2) {
								// X
								tgtInstrument.tmpEqFilterEnd.controlPoints[Math.floor((dotTarget - 1) / 2)].freq =
									tone.expression + tone.expressionDelta;
							} else {
								// Y
								tgtInstrument.tmpEqFilterEnd.controlPoints[Math.floor((dotTarget - 1) / 2)].gain =
									tone.expression + tone.expressionDelta;
							}
						}
					}
				}
			}
			// Extra info for note filter target needs to be set as well
			else if (setting == Config.modulators.dictionary["note filter"].index) {
				const tgtInstrument =
					synth.song.channels[instrument.modChannels[mod]].instruments[usedInstruments[instrumentIndex]];

				if (!tgtInstrument.noteFilterType) {
					let dotTarget = instrument.modFilterTypes[mod] | 0;

					if (dotTarget == 0) {
						// Morph. Figure out the target filter's X/Y coords for this point. If no point exists with this index, or point types don't match, do lerp-out for this point and lerp-in of a new point

						let pinIdx: number = 0;
						const currentPart: number = synth.getTicksIntoBar() / Config.ticksPerPart;
						while (tone.note!.start + tone.note!.pins[pinIdx].time <= currentPart) pinIdx++;
						// 0 to 1 based on distance to next morph
						//let lerpStartRatio: number = (currentPart - tone.note!.pins[pinIdx - 1].time) / (tone.note!.pins[pinIdx].time - tone.note!.pins[pinIdx - 1].time);
						let lerpEndRatio: number =
							(currentPart -
								tone.note!.start +
								(roundedSamplesPerTick / (synth.getSamplesPerTick() * Config.ticksPerPart)) *
									Config.ticksPerPart -
								tone.note!.pins[pinIdx - 1].time) /
							(tone.note!.pins[pinIdx].time - tone.note!.pins[pinIdx - 1].time);

						// Compute the new settings to go to.
						if (
							tgtInstrument.noteSubFilters[tone.note!.pins[pinIdx - 1].size] != null ||
							tgtInstrument.noteSubFilters[tone.note!.pins[pinIdx].size] != null
						) {
							tgtInstrument.tmpNoteFilterEnd = FilterSettings.lerpFilters(
								tgtInstrument.noteSubFilters[tone.note!.pins[pinIdx - 1].size]!,
								tgtInstrument.noteSubFilters[tone.note!.pins[pinIdx].size]!,
								lerpEndRatio
							);
						} else {
							// No mutation will occur to the filter object so we can safely return it without copying
							tgtInstrument.tmpNoteFilterEnd = tgtInstrument.noteFilter;
						}
					} // Target (1 is dot 1 X, 2 is dot 1 Y, etc.)
					else {
						// Since we are directly manipulating the filter, make sure it is a new one and not an actual one of the instrument's filters

						for (let i: number = 0; i < Config.filterMorphCount; i++) {
							if (
								tgtInstrument.tmpNoteFilterEnd == tgtInstrument.noteSubFilters[i] &&
								tgtInstrument.tmpNoteFilterEnd != null
							) {
								tgtInstrument.tmpNoteFilterEnd = new FilterSettings();
								tgtInstrument.tmpNoteFilterEnd.fromJsonObject(
									tgtInstrument.noteSubFilters[i]!.toJsonObject()
								);
							}
						}
						if (tgtInstrument.tmpNoteFilterEnd == null) {
							tgtInstrument.tmpNoteFilterEnd = new FilterSettings();
							tgtInstrument.tmpNoteFilterEnd.fromJsonObject(tgtInstrument.noteFilter.toJsonObject());
						}

						if (tgtInstrument.tmpNoteFilterEnd.controlPointCount > Math.floor((dotTarget - 1) / 2)) {
							if (dotTarget % 2) {
								// X
								tgtInstrument.tmpNoteFilterEnd.controlPoints[Math.floor((dotTarget - 1) / 2)].freq =
									tone.expression + tone.expressionDelta;
							} else {
								// Y
								tgtInstrument.tmpNoteFilterEnd.controlPoints[Math.floor((dotTarget - 1) / 2)].gain =
									tone.expression + tone.expressionDelta;
							}
						}
					}
				}
			}
		}
	}

	private static findRandomZeroCrossing(wave: Float32Array, waveLength: number): number {
		let phase: number = Math.random() * waveLength;
		const phaseMask: number = waveLength - 1;

		// Spectrum and drumset waves sounds best when they start at a zero crossing,
		// otherwise they pop. Try to find a zero crossing.
		let indexPrev: number = phase & phaseMask;
		let wavePrev: number = wave[indexPrev];
		const stride: number = 16;
		for (let attemptsRemaining: number = 128; attemptsRemaining > 0; attemptsRemaining--) {
			const indexNext: number = (indexPrev + stride) & phaseMask;
			const waveNext: number = wave[indexNext];
			if (wavePrev * waveNext <= 0.0) {
				// Found a zero crossing! Now let's narrow it down to two adjacent sample indices.
				for (let i: number = 0; i < stride; i++) {
					const innerIndexNext: number = (indexPrev + 1) & phaseMask;
					const innerWaveNext: number = wave[innerIndexNext];
					if (wavePrev * innerWaveNext <= 0.0) {
						// Found the zero crossing again! Now let's find the exact intersection.
						const slope: number = innerWaveNext - wavePrev;
						phase = indexPrev;
						if (Math.abs(slope) > 0.00000001) {
							phase += -wavePrev / slope;
						}
						phase = Math.max(0, phase) % waveLength;
						break;
					} else {
						indexPrev = innerIndexNext;
						wavePrev = innerWaveNext;
					}
				}
				break;
			} else {
				indexPrev = indexNext;
				wavePrev = waveNext;
			}
		}

		return phase;
	}

	public static instrumentVolumeToVolumeMult(instrumentVolume: number): number {
		return instrumentVolume == -Config.volumeRange / 2.0
			? 0.0
			: Math.pow(2, Config.volumeLogScale * instrumentVolume);
	}
	public static volumeMultToInstrumentVolume(volumeMult: number): number {
		return volumeMult <= 0.0
			? -Config.volumeRange / 2
			: Math.min(Config.volumeRange, Math.log(volumeMult) / Math.LN2 / Config.volumeLogScale);
	}
	public static noteSizeToVolumeMult(size: number): number {
		return Math.pow(Math.max(0.0, size) / Config.noteSizeMax, 1.5);
	}
	public static volumeMultToNoteSize(volumeMult: number): number {
		return Math.pow(Math.max(0.0, volumeMult), 1 / 1.5) * Config.noteSizeMax;
	}

	public static fadeInSettingToSeconds(setting: number): number {
		return 0.0125 * (0.95 * setting + 0.05 * setting * setting);
	}
	public static secondsToFadeInSetting(seconds: number): number {
		return clamp(0, Config.fadeInRange, Math.round((-0.95 + Math.sqrt(0.9025 + (0.2 * seconds) / 0.0125)) / 0.1));
	}
	public static fadeOutSettingToTicks(setting: number): number {
		return Config.fadeOutTicks[setting];
	}
	public static ticksToFadeOutSetting(ticks: number): number {
		let lower: number = Config.fadeOutTicks[0];
		if (ticks <= lower) return 0;
		for (let i: number = 1; i < Config.fadeOutTicks.length; i++) {
			let upper: number = Config.fadeOutTicks[i];
			if (ticks <= upper) return ticks < (lower + upper) / 2 ? i - 1 : i;
			lower = upper;
		}
		return Config.fadeOutTicks.length - 1;
	}

	public static detuneToCents(detune: number): number {
		// BeepBox formula, for reference:
		// return detune * (Math.abs(detune) + 1) / 2;
		return detune - Config.detuneCenter;
	}
	public static centsToDetune(cents: number): number {
		// BeepBox formula, for reference:
		// return Math.sign(cents) * (Math.sqrt(1 + 8 * Math.abs(cents)) - 1) / 2.0;
		return cents + Config.detuneCenter;
	}

	public static getOperatorWave(waveform: number, pulseWidth: number) {
		if (waveform != 3) {
			return Config.operatorWaves[waveform];
		} else {
			return Config.pwmOperatorWaves[pulseWidth];
		}
	}

	private getSamplesPerTick(): number {
		if (this.song == null) return 0;
		let beatsPerMinute: number = this.song.getBeatsPerMinute();
		if (this.isModActive(Config.modulators.dictionary["tempo"].index)) {
			beatsPerMinute = this.getModValue(Config.modulators.dictionary["tempo"].index);
		}
		return this.getSamplesPerTickSpecificBPM(beatsPerMinute);
	}

	private getSamplesPerTickSpecificBPM(beatsPerMinute: number): number {
		const beatsPerSecond: number = beatsPerMinute / 60.0;
		const partsPerSecond: number = Config.partsPerBeat * beatsPerSecond;
		const tickPerSecond: number = Config.ticksPerPart * partsPerSecond;
		return this.samplesPerSecond / tickPerSecond;
	}

	public static fittingPowerOfTwo(x: number): number {
		return 1 << (32 - Math.clz32(Math.ceil(x) - 1));
	}

	private sanitizeFilters(filters: DynamicBiquadFilter[]): void {
		let reset: boolean = false;
		for (const filter of filters) {
			const output1: number = Math.abs(filter.output1);
			const output2: number = Math.abs(filter.output2);
			// If either is a large value, Infinity, or NaN, then just reset all filter history.
			if (!(output1 < 100) || !(output2 < 100)) {
				reset = true;
				break;
			}
			if (output1 < epsilon) filter.output1 = 0.0;
			if (output2 < epsilon) filter.output2 = 0.0;
		}
		if (reset) {
			for (const filter of filters) {
				filter.output1 = 0.0;
				filter.output2 = 0.0;
			}
		}
	}

	public static sanitizeDelayLine(delayLine: Float32Array, lastIndex: number, mask: number): void {
		while (true) {
			lastIndex--;
			const index: number = lastIndex & mask;
			const sample: number = Math.abs(delayLine[index]);
			if (Number.isFinite(sample) && (sample == 0.0 || sample >= epsilon)) break;
			delayLine[index] = 0.0;
		}
	}

	public static applyFilters(
		sample: number,
		input1: number,
		input2: number,
		filterCount: number,
		filters: DynamicBiquadFilter[]
	): number {
		for (let i: number = 0; i < filterCount; i++) {
			const filter: DynamicBiquadFilter = filters[i];
			const output1: number = filter.output1;
			const output2: number = filter.output2;
			const a1: number = filter.a1;
			const a2: number = filter.a2;
			const b0: number = filter.b0;
			const b1: number = filter.b1;
			const b2: number = filter.b2;
			sample = b0 * sample + b1 * input1 + b2 * input2 - a1 * output1 - a2 * output2;
			filter.a1 = a1 + filter.a1Delta;
			filter.a2 = a2 + filter.a2Delta;
			if (filter.useMultiplicativeInputCoefficients) {
				filter.b0 = b0 * filter.b0Delta;
				filter.b1 = b1 * filter.b1Delta;
				filter.b2 = b2 * filter.b2Delta;
			} else {
				filter.b0 = b0 + filter.b0Delta;
				filter.b1 = b1 + filter.b1Delta;
				filter.b2 = b2 + filter.b2Delta;
			}
			filter.output2 = output1;
			filter.output1 = sample;
			// Updating the input values is waste if the next filter doesn't exist...
			input2 = output2;
			input1 = output1;
		}
		return sample;
	}
}

// When compiling synth.ts as a standalone module named "beepbox", expose these classes as members to JavaScript:
export {
	type Dictionary,
	type DictionaryArray,
	FilterType,
	type EnvelopeType,
	InstrumentType,
	type Transition,
	type Chord,
	type Envelope,
	Config
};
