import { base64CharCodeToInt } from "./Types";

export class BitFieldReader
{
	private _bits: number[] = [];
	private _readIndex: number = 0;

	constructor(source: string, startIndex: number, stopIndex: number)
	{
		for (let i: number = startIndex; i < stopIndex; i++)
		{
			const value: number = base64CharCodeToInt[source.charCodeAt(i)];
			this._bits.push((value >> 5) & 1);
			this._bits.push((value >> 4) & 1);
			this._bits.push((value >> 3) & 1);
			this._bits.push((value >> 2) & 1);
			this._bits.push((value >> 1) & 1);
			this._bits.push(value & 1);
		}
	}

	public read(bitCount: number): number
	{
		let result: number = 0;
		while (bitCount > 0)
		{
			result = result << 1;
			result += this._bits[this._readIndex++];
			bitCount--;
		}
		return result;
	}

	public readLongTail(minValue: number, minBits: number): number
	{
		let result: number = minValue;
		let numBits: number = minBits;
		while (this._bits[this._readIndex++])
		{
			result += 1 << numBits;
			numBits++;
		}
		while (numBits > 0)
		{
			numBits--;
			if (this._bits[this._readIndex++])
			{
				result += 1 << numBits;
			}
		}
		return result;
	}

	public readPartDuration(): number
	{
		return this.readLongTail(1, 3);
	}

	public readLegacyPartDuration(): number
	{
		return this.readLongTail(1, 2);
	}

	public readPinCount(): number
	{
		return this.readLongTail(1, 0);
	}

	public readPitchInterval(): number
	{
		if (this.read(1))
		{
			return -this.readLongTail(1, 3);
		} else
		{
			return this.readLongTail(1, 3);
		}
	}
}
