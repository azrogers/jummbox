/** @format */

import {
	FilterType,
	EnvelopeType,
	EnvelopeComputeIndex,
	Transition,
	Envelope,
	AutomationTarget,
	Config
} from "./SynthConfig";
import { NotePin } from "./Note";
import { Instrument } from "./Instrument";
import { FilterSettings } from "./Filter";
import { Synth } from "./synth";
import { Tone } from "./Tone";
import { clamp } from "./synth";

export class EnvelopeComputer {
	public noteSecondsStart: number = 0;
	public noteSecondsEnd: number = 0;
	public noteTicksStart: number = 0;
	public noteTicksEnd: number = 0;
	public noteSizeStart: number = Config.noteSizeMax;
	public noteSizeEnd: number = Config.noteSizeMax;
	public prevNoteSize: number = Config.noteSizeMax;
	public nextNoteSize: number = Config.noteSizeMax;
	private _noteSizeFinal: number = Config.noteSizeMax;
	public prevNoteSecondsStart: number = 0;
	public prevNoteSecondsEnd: number = 0;
	public prevNoteTicksStart: number = 0;
	public prevNoteTicksEnd: number = 0;
	private _prevNoteSizeFinal: number = Config.noteSizeMax;

	public prevSlideStart: boolean = false;
	public prevSlideEnd: boolean = false;
	public nextSlideStart: boolean = false;
	public nextSlideEnd: boolean = false;
	public prevSlideRatioStart: number = 0;
	public prevSlideRatioEnd: number = 0;
	public nextSlideRatioStart: number = 0;
	public nextSlideRatioEnd: number = 0;

	public readonly envelopeStarts: number[] = [];
	public readonly envelopeEnds: number[] = [];
	private readonly _modifiedEnvelopeIndices: number[] = [];
	private _modifiedEnvelopeCount: number = 0;
	public lowpassCutoffDecayVolumeCompensation: number = 1;

	constructor(/*private _perNote: boolean*/) {
		//const length: number = this._perNote ? EnvelopeComputeIndex.length : InstrumentAutomationIndex.length;
		const length: number = EnvelopeComputeIndex.length;
		for (let i: number = 0; i < length; i++) {
			this.envelopeStarts[i] = 1;
			this.envelopeEnds[i] = 1;
		}

		this.reset();
	}

	public reset(): void {
		this.noteSecondsEnd = 0;
		this.noteTicksEnd = 0;
		this._noteSizeFinal = Config.noteSizeMax;
		this.prevNoteSecondsEnd = 0;
		this.prevNoteTicksEnd = 0;
		this._prevNoteSizeFinal = Config.noteSizeMax;
		this._modifiedEnvelopeCount = 0;
	}

	public computeEnvelopes(
		instrument: Instrument,
		currentPart: number,
		tickTimeStart: number,
		secondsPerTick: number,
		tone: Tone | null
	): void {
		const transition: Transition = instrument.getTransition();
		if (tone != null && tone.atNoteStart && !transition.continues && !tone.forceContinueAtStart) {
			this.prevNoteSecondsEnd = this.noteSecondsEnd;
			this.prevNoteTicksEnd = this.noteTicksEnd;
			this._prevNoteSizeFinal = this._noteSizeFinal;
			this.noteSecondsEnd = 0;
			this.noteTicksEnd = 0;
		}
		if (tone != null) {
			if (tone.note != null) {
				this._noteSizeFinal = tone.note.pins[tone.note.pins.length - 1].size;
			} else {
				this._noteSizeFinal = Config.noteSizeMax;
			}
		}

		const tickTimeEnd: number = tickTimeStart + 1;
		const noteSecondsStart: number = this.noteSecondsEnd;
		const noteSecondsEnd: number = noteSecondsStart + secondsPerTick;
		const noteTicksStart: number = this.noteTicksEnd;
		const noteTicksEnd: number = noteTicksStart + 1;
		const prevNoteSecondsStart: number = this.prevNoteSecondsEnd;
		const prevNoteSecondsEnd: number = prevNoteSecondsStart + secondsPerTick;
		const prevNoteTicksStart: number = this.prevNoteTicksEnd;
		const prevNoteTicksEnd: number = prevNoteTicksStart + 1;

		const beatsPerTick: number = 1 / (Config.ticksPerPart * Config.partsPerBeat);
		const beatTimeStart: number = beatsPerTick * tickTimeStart;
		const beatTimeEnd: number = beatsPerTick * tickTimeEnd;

		let noteSizeStart: number = this._noteSizeFinal;
		let noteSizeEnd: number = this._noteSizeFinal;
		let prevNoteSize: number = this._prevNoteSizeFinal;
		let nextNoteSize: number = 0;
		let prevSlideStart: boolean = false;
		let prevSlideEnd: boolean = false;
		let nextSlideStart: boolean = false;
		let nextSlideEnd: boolean = false;
		let prevSlideRatioStart: number = 0;
		let prevSlideRatioEnd: number = 0;
		let nextSlideRatioStart: number = 0;
		let nextSlideRatioEnd: number = 0;
		if (tone != null && tone.note != null && !tone.passedEndOfNote) {
			const endPinIndex: number = tone.note.getEndPinIndex(currentPart);
			const startPin: NotePin = tone.note.pins[endPinIndex - 1];
			const endPin: NotePin = tone.note.pins[endPinIndex];
			const startPinTick: number = (tone.note.start + startPin.time) * Config.ticksPerPart;
			const endPinTick: number = (tone.note.start + endPin.time) * Config.ticksPerPart;
			const ratioStart: number = (tickTimeStart - startPinTick) / (endPinTick - startPinTick);
			const ratioEnd: number = (tickTimeEnd - startPinTick) / (endPinTick - startPinTick);
			noteSizeStart = startPin.size + (endPin.size - startPin.size) * ratioStart;
			noteSizeEnd = startPin.size + (endPin.size - startPin.size) * ratioEnd;

			if (transition.slides) {
				const noteStartTick: number = tone.noteStartPart * Config.ticksPerPart;
				const noteEndTick: number = tone.noteEndPart * Config.ticksPerPart;
				const noteLengthTicks: number = noteEndTick - noteStartTick;
				const maximumSlideTicks: number = noteLengthTicks * 0.5;
				const slideTicks: number = Math.min(maximumSlideTicks, transition.slideTicks);
				if (tone.prevNote != null && !tone.forceContinueAtStart) {
					if (tickTimeStart - noteStartTick < slideTicks) {
						prevSlideStart = true;
						prevSlideRatioStart = 0.5 * (1 - (tickTimeStart - noteStartTick) / slideTicks);
					}
					if (tickTimeEnd - noteStartTick < slideTicks) {
						prevSlideEnd = true;
						prevSlideRatioEnd = 0.5 * (1 - (tickTimeEnd - noteStartTick) / slideTicks);
					}
				}
				if (tone.nextNote != null && !tone.forceContinueAtEnd) {
					nextNoteSize = tone.nextNote.pins[0].size;
					if (noteEndTick - tickTimeStart < slideTicks) {
						nextSlideStart = true;
						nextSlideRatioStart = 0.5 * (1 - (noteEndTick - tickTimeStart) / slideTicks);
					}
					if (noteEndTick - tickTimeEnd < slideTicks) {
						nextSlideEnd = true;
						nextSlideRatioEnd = 0.5 * (1 - (noteEndTick - tickTimeEnd) / slideTicks);
					}
				}
			}
		}

		let lowpassCutoffDecayVolumeCompensation: number = 1;
		let usedNoteSize: boolean = false;
		for (let envelopeIndex: number = 0; envelopeIndex <= instrument.envelopeCount; envelopeIndex++) {
			let automationTarget: AutomationTarget;
			let targetIndex: number;
			let envelope: Envelope;
			if (envelopeIndex == instrument.envelopeCount) {
				if (usedNoteSize /*|| !this._perNote*/) break;
				// Special case: if no other envelopes used note size, default to applying it to note volume.
				automationTarget = Config.instrumentAutomationTargets.dictionary["noteVolume"];
				targetIndex = 0;
				envelope = Config.envelopes.dictionary["note size"];
			} else {
				let envelopeSettings: EnvelopeSettings = instrument.envelopes[envelopeIndex];
				automationTarget = Config.instrumentAutomationTargets[envelopeSettings.target];
				targetIndex = envelopeSettings.index;
				envelope = Config.envelopes[envelopeSettings.envelope];
				if (envelope.type == EnvelopeType.noteSize) usedNoteSize = true;
			}
			if (/*automationTarget.perNote == this._perNote &&*/ automationTarget.computeIndex != null) {
				const computeIndex: number = automationTarget.computeIndex + targetIndex;
				let envelopeStart: number = EnvelopeComputer.computeEnvelope(
					envelope,
					noteSecondsStart,
					beatTimeStart,
					noteSizeStart
				);
				let envelopeEnd: number = EnvelopeComputer.computeEnvelope(
					envelope,
					noteSecondsEnd,
					beatTimeEnd,
					noteSizeEnd
				);

				if (prevSlideStart) {
					const other: number = EnvelopeComputer.computeEnvelope(
						envelope,
						prevNoteSecondsStart,
						beatTimeStart,
						prevNoteSize
					);
					envelopeStart += (other - envelopeStart) * prevSlideRatioStart;
				}
				if (prevSlideEnd) {
					const other: number = EnvelopeComputer.computeEnvelope(
						envelope,
						prevNoteSecondsEnd,
						beatTimeEnd,
						prevNoteSize
					);
					envelopeEnd += (other - envelopeEnd) * prevSlideRatioEnd;
				}
				if (nextSlideStart) {
					const other: number = EnvelopeComputer.computeEnvelope(envelope, 0, beatTimeStart, nextNoteSize);
					envelopeStart += (other - envelopeStart) * nextSlideRatioStart;
				}
				if (nextSlideEnd) {
					const other: number = EnvelopeComputer.computeEnvelope(envelope, 0, beatTimeEnd, nextNoteSize);
					envelopeEnd += (other - envelopeEnd) * nextSlideRatioEnd;
				}

				this.envelopeStarts[computeIndex] *= envelopeStart;
				this.envelopeEnds[computeIndex] *= envelopeEnd;
				this._modifiedEnvelopeIndices[this._modifiedEnvelopeCount++] = computeIndex;

				if (automationTarget.isFilter) {
					const filterSettings: FilterSettings =
						/*this._perNote ?*/ instrument.tmpNoteFilterStart != null
							? instrument.tmpNoteFilterStart
							: instrument.noteFilter; /*: instrument.eqFilter*/
					if (
						filterSettings.controlPointCount > targetIndex &&
						filterSettings.controlPoints[targetIndex].type == FilterType.lowPass
					) {
						lowpassCutoffDecayVolumeCompensation = Math.max(
							lowpassCutoffDecayVolumeCompensation,
							EnvelopeComputer.getLowpassCutoffDecayVolumeCompensation(envelope)
						);
					}
				}
			}
		}

		this.noteSecondsStart = noteSecondsStart;
		this.noteSecondsEnd = noteSecondsEnd;
		this.noteTicksStart = noteTicksStart;
		this.noteTicksEnd = noteTicksEnd;
		this.prevNoteSecondsStart = prevNoteSecondsStart;
		this.prevNoteSecondsEnd = prevNoteSecondsEnd;
		this.prevNoteTicksStart = prevNoteTicksStart;
		this.prevNoteTicksEnd = prevNoteTicksEnd;
		this.prevNoteSize = prevNoteSize;
		this.nextNoteSize = nextNoteSize;
		this.noteSizeStart = noteSizeStart;
		this.noteSizeEnd = noteSizeEnd;
		this.prevSlideStart = prevSlideStart;
		this.prevSlideEnd = prevSlideEnd;
		this.nextSlideStart = nextSlideStart;
		this.nextSlideEnd = nextSlideEnd;
		this.prevSlideRatioStart = prevSlideRatioStart;
		this.prevSlideRatioEnd = prevSlideRatioEnd;
		this.nextSlideRatioStart = nextSlideRatioStart;
		this.nextSlideRatioEnd = nextSlideRatioEnd;
		this.lowpassCutoffDecayVolumeCompensation = lowpassCutoffDecayVolumeCompensation;
	}

	public clearEnvelopes(): void {
		for (let envelopeIndex: number = 0; envelopeIndex < this._modifiedEnvelopeCount; envelopeIndex++) {
			const computeIndex: number = this._modifiedEnvelopeIndices[envelopeIndex];
			this.envelopeStarts[computeIndex] = 1;
			this.envelopeEnds[computeIndex] = 1;
		}
		this._modifiedEnvelopeCount = 0;
	}

	public static computeEnvelope(envelope: Envelope, time: number, beats: number, noteSize: number): number {
		switch (envelope.type) {
			case EnvelopeType.noteSize:
				return Synth.noteSizeToVolumeMult(noteSize);
			case EnvelopeType.none:
				return 1;
			case EnvelopeType.twang:
				return 1 / (1 + time * envelope.speed);
			case EnvelopeType.swell:
				return 1 - 1 / (1 + time * envelope.speed);
			case EnvelopeType.tremolo:
				return 0.5 - Math.cos(beats * 2 * Math.PI * envelope.speed) * 0.5;
			case EnvelopeType.tremolo2:
				return 0.75 - Math.cos(beats * 2 * Math.PI * envelope.speed) * 0.25;
			case EnvelopeType.punch:
				return Math.max(1, 2 - time * 10);
			case EnvelopeType.flare:
				const attack: number = 0.25 / Math.sqrt(envelope.speed);
				return time < attack ? time / attack : 1 / (1 + (time - attack) * envelope.speed);
			case EnvelopeType.decay:
				return Math.pow(2, -envelope.speed * time);
			default:
				throw new Error("Unrecognized operator envelope type.");
		}
	}

	public static getLowpassCutoffDecayVolumeCompensation(envelope: Envelope): number {
		// This is a little hokey in the details, but I designed it a while ago and keep it
		// around for compatibility. This decides how much to increase the volume (or
		// expression) to compensate for a decaying lowpass cutoff to maintain perceived
		// volume overall.
		if (envelope.type == EnvelopeType.decay) return 1.25 + 0.025 * envelope.speed;
		if (envelope.type == EnvelopeType.twang) return 1 + 0.02 * envelope.speed;
		return 1;
	}
}

export class EnvelopeSettings {
	public target: number = 0;
	public index: number = 0;
	public envelope: number = 0;

	constructor() {
		this.reset();
	}

	reset(): void {
		this.target = 0;
		this.index = 0;
		this.envelope = 0;
	}

	public toJsonObject(): Object {
		const envelopeObject: any = {
			"target": Config.instrumentAutomationTargets[this.target].name,
			"envelope": Config.envelopes[this.envelope].name
		};
		if (Config.instrumentAutomationTargets[this.target].maxCount > 1) {
			envelopeObject["index"] = this.index;
		}
		return envelopeObject;
	}

	public fromJsonObject(envelopeObject: any): void {
		this.reset();

		let target: AutomationTarget = Config.instrumentAutomationTargets.dictionary[envelopeObject["target"]];
		if (target == null) target = Config.instrumentAutomationTargets.dictionary["noteVolume"];
		this.target = target.index;

		let envelope: Envelope = Config.envelopes.dictionary[envelopeObject["envelope"]];
		if (envelope == null) envelope = Config.envelopes.dictionary["none"];
		this.envelope = envelope.index;

		if (envelopeObject["index"] != undefined) {
			this.index = clamp(
				0,
				Config.instrumentAutomationTargets[this.target].maxCount,
				envelopeObject["index"] | 0
			);
		} else {
			this.index = 0;
		}
	}
}
