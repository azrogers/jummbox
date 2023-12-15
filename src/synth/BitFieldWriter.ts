import { base64IntToCharCode } from "./Types";

export class BitFieldWriter
{
	private _index: number = 0;
	private _bits: number[] = [];

	public clear()
	{
		this._index = 0;
	}

	public write(bitCount: number, value: number): void
	{
		bitCount--;
		while (bitCount >= 0)
		{
			this._bits[this._index++] = (value >>> bitCount) & 1;
			bitCount--;
		}
	}

	public writeLongTail(minValue: number, minBits: number, value: number): void
	{
		if (value < minValue) throw new Error("value out of bounds");
		value -= minValue;
		let numBits: number = minBits;
		while (value >= (1 << numBits))
		{
			this._bits[this._index++] = 1;
			value -= 1 << numBits;
			numBits++;
		}
		this._bits[this._index++] = 0;
		while (numBits > 0)
		{
			numBits--;
			this._bits[this._index++] = (value >>> numBits) & 1;
		}
	}

	public writePartDuration(value: number): void
	{
		this.writeLongTail(1, 3, value);
	}

	public writePinCount(value: number): void
	{
		this.writeLongTail(1, 0, value);
	}

	public writePitchInterval(value: number): void
	{
		if (value < 0)
		{
			this.write(1, 1); // sign
			this.writeLongTail(1, 3, -value);
		} else
		{
			this.write(1, 0); // sign
			this.writeLongTail(1, 3, value);
		}
	}

	public concat(other: BitFieldWriter): void
	{
		for (let i: number = 0; i < other._index; i++)
		{
			this._bits[this._index++] = other._bits[i];
		}
	}

	public encodeBase64(buffer: number[]): number[]
	{

		for (let i: number = 0; i < this._index; i += 6)
		{
			const value: number = (this._bits[i] << 5) | (this._bits[i + 1] << 4) | (this._bits[i + 2] << 3) | (this._bits[i + 3] << 2) | (this._bits[i + 4] << 1) | this._bits[i + 5];
			buffer.push(base64IntToCharCode[value]);
		}
		return buffer;
	}

	public lengthBase64(): number
	{
		return Math.ceil(this._index / 6);
	}
}
