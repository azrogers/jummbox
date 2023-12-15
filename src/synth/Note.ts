/** @format */

export class Note {
	public pitches: number[];
	public pins: NotePin[];
	public start: number;
	public end: number;
	public continuesLastPattern: boolean;

	public constructor(pitch: number, start: number, end: number, size: number, fadeout: boolean = false) {
		this.pitches = [pitch];
		this.pins = [makeNotePin(0, 0, size), makeNotePin(0, end - start, fadeout ? 0 : size)];
		this.start = start;
		this.end = end;
		this.continuesLastPattern = false;
	}

	public pickMainInterval(): number {
		let longestFlatIntervalDuration: number = 0;
		let mainInterval: number = 0;
		for (let pinIndex: number = 1; pinIndex < this.pins.length; pinIndex++) {
			const pinA: NotePin = this.pins[pinIndex - 1];
			const pinB: NotePin = this.pins[pinIndex];
			if (pinA.interval == pinB.interval) {
				const duration: number = pinB.time - pinA.time;
				if (longestFlatIntervalDuration < duration) {
					longestFlatIntervalDuration = duration;
					mainInterval = pinA.interval;
				}
			}
		}
		if (longestFlatIntervalDuration == 0) {
			let loudestSize: number = 0;
			for (let pinIndex: number = 0; pinIndex < this.pins.length; pinIndex++) {
				const pin: NotePin = this.pins[pinIndex];
				if (loudestSize < pin.size) {
					loudestSize = pin.size;
					mainInterval = pin.interval;
				}
			}
		}
		return mainInterval;
	}

	public clone(): Note {
		const newNote: Note = new Note(-1, this.start, this.end, 3);
		newNote.pitches = this.pitches.concat();
		newNote.pins = [];
		for (const pin of this.pins) {
			newNote.pins.push(makeNotePin(pin.interval, pin.time, pin.size));
		}
		newNote.continuesLastPattern = this.continuesLastPattern;
		return newNote;
	}

	public getEndPinIndex(part: number): number {
		let endPinIndex: number;
		for (endPinIndex = 1; endPinIndex < this.pins.length - 1; endPinIndex++) {
			if (this.pins[endPinIndex].time + this.start > part) break;
		}
		return endPinIndex;
	}
}
export interface NotePin {
	interval: number;
	time: number;
	size: number;
}
export function makeNotePin(interval: number, time: number, size: number): NotePin {
	return { interval: interval, time: time, size: size };
}
