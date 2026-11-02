import type { MouseStatus } from "@openmouse/protocol/drivers/mouse-types";

/*
 * AULA SC580 (wireless receiver 0x089D:0x062F, wired 0x088D:0x062E), DPI stages only.
 * Transport: the HID collection on usage page 0xFF02, 33-byte reports (ID 0 + 32 bytes).
 * Frame, both ways: [cmd, status, 0x01, len, data..., zero pad, checksum at [31]] where the
 * checksum is the low byte of the sum of the data bytes. Replies carry status 0 (ok), 1 (busy) or 2
 * (rejected: the mouse is asleep and the receiver only echoes). Decoded from the vendor
 * CBMouse app's WriteFile calls and verified on hardware.
 */

const AULA_SC580_PRODUCTS = [
  { vendorId: 0x089d, productId: 0x062f },
  { vendorId: 0x088d, productId: 0x062e },
] as const;
const SETTINGS_USAGE_PAGE = 0xff02;
const PAYLOAD_SIZE = 32;
const MAX_DATA = 27;
const CMD_IDENTIFY = 0x30;
const CMD_READ_DPI = 0x13;
const CMD_WRITE_DPI = 0x03;
const CMD_READ_RATE = 0x12;
const CMD_WRITE_RATE = 0x02;
const STAGE_COUNT = 6;
/** One data byte, one bit per rate in this order (0x01 125 Hz ... 0x08 1000 Hz), as the vendor app writes it. */
export const AULA_SC580_POLLING_RATES = [125, 250, 500, 1000];
const WAKE_MESSAGE = "AULA SC580 did not answer. Move the mouse to wake it, then try again.";

/** The vendor config grid: 50 to 10000 in steps of 50, then 10100 to 12000 in steps of 100. */
export const AULA_SC580_DPI_OPTIONS: number[] = [
  ...Array.from({ length: 200 }, (_, i) => (i + 1) * 50),
  ...Array.from({ length: 20 }, (_, i) => 10100 + i * 100),
];

export function buildAulaFrame(cmd: number, data: ArrayLike<number> = []): Uint8Array<ArrayBuffer> {
  if (data.length > MAX_DATA) throw new Error("AULA frame data is too long.");
  const frame = new Uint8Array(PAYLOAD_SIZE);
  frame[0] = cmd;
  frame[2] = 0x01;
  frame[3] = data.length;
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    frame[4 + i] = data[i]!;
    sum += data[i]!;
  }
  frame[31] = sum & 0xff;
  return frame;
}

export function parseAulaReply(bytes: Uint8Array): { cmd: number; status: number; data: Uint8Array } | null {
  if (bytes.length < PAYLOAD_SIZE) return null;
  const status = bytes[1]!;
  const len = bytes[3]!;
  if (len > MAX_DATA) return null;
  const data = bytes.slice(4, 4 + len);
  // A status-2 echo is our own request frame, so its checksum is not validated.
  if (status === 0 && (data.reduce((sum, byte) => sum + byte, 0) & 0xff) !== bytes[31]) return null;
  return { cmd: bytes[0]!, status, data };
}

/**
 * Raw stage byte: DPI / 50 up to 10000 (raw 200), then 200 + (DPI - 10000) / 100, so 12000 is raw 220.
 * From the vendor config (DPIRANGE ... 10100,12000,100,201) and the vendor app showing raw 0xdc as 12000.
 */
export function aulaDpiFromRaw(raw: number): number {
  return raw <= 200 ? raw * 50 : 10000 + (raw - 200) * 100;
}

export function aulaRawFromDpi(dpi: number): number {
  return dpi <= 10000 ? dpi / 50 : 200 + (dpi - 10000) / 100;
}

export function decodeAulaDpiTable(data: Uint8Array): { header: number; stages: number[] } {
  if (data.length < 1 + STAGE_COUNT * 4) throw new Error("AULA SC580 sent a short DPI table.");
  return { header: data[0]!, stages: Array.from({ length: STAGE_COUNT }, (_, i) => aulaDpiFromRaw(data[1 + i * 4]!)) };
}

/** The 27 data bytes of a DPI write: offset 0, the header as read, six 4-byte stages, one pad byte. */
export function encodeAulaDpiWrite(header: number, stages: number[]): Uint8Array {
  const data = new Uint8Array(MAX_DATA);
  data[1] = header;
  stages.forEach((dpi, i) => { data[2 + i * 4] = aulaRawFromDpi(dpi); });
  return data;
}

export interface AulaSc580Options { replyTimeoutMs?: number; retries?: number; retryDelayMs?: number }

type Reply = { status: number; data: Uint8Array };

export class AulaSc580HidClient {
  readonly device: HIDDevice;
  private readonly replyTimeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private opened = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice, options: AulaSc580Options = {}) {
    this.device = device;
    this.replyTimeoutMs = options.replyTimeoutMs ?? 800;
    this.retries = options.retries ?? 10;
    this.retryDelayMs = options.retryDelayMs ?? 400;
  }

  /** The mouse itself on its cable (0x088D) rather than the receiver; while plugged in it only talks this way. */
  static isWired(device: HIDDevice): boolean {
    return device.vendorId === AULA_SC580_PRODUCTS[1].vendorId && device.productId === AULA_SC580_PRODUCTS[1].productId;
  }

  static isSupported(device: HIDDevice): boolean {
    return AULA_SC580_PRODUCTS.some((p) => p.vendorId === device.vendorId && p.productId === device.productId)
      && device.collections.some((c) => c.usagePage === SETTINGS_USAGE_PAGE);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    this.opened = true;
  }

  async close(): Promise<void> {
    if (this.opened && this.device.opened) await this.device.close();
    this.opened = false;
  }

  private async ensureOpen(): Promise<void> {
    if (!this.device.opened) await this.open();
    this.opened = true;
  }

  getDpiOptions(): number[] {
    return AULA_SC580_DPI_OPTIONS;
  }

  get supportedPollingRates(): number[] {
    return AULA_SC580_POLLING_RATES;
  }

  async readStatus(): Promise<MouseStatus> {
    const id = await this.exchange(CMD_IDENTIFY, []);
    if (String.fromCharCode(...id.slice(0, 4)) !== "M137") throw new Error("This device did not identify as an AULA SC580.");
    const { stages } = await this.readTable();
    // Identify byte 8 is 1 while the cable is in (charging) and 0 on battery. Byte 9 is the charge
    // in percent on battery (seen counting down 62 -> 61, matching the vendor app's icon), but it
    // jumps straight to 100 on the cable, so it is not shown while charging.
    const charging = id[8] === 1;
    const battery = id[9];
    const pollingRateHz = await this.readPollingRate();
    // dpi 0 means unknown (the active stage is not readable yet); so does pollingRateHz 0.
    return {
      // AULA is not in the protocol package's closed brand union.
      brand: "AULA" as MouseStatus["brand"],
      name: "AULA SC580",
      batteryPercent: !charging && battery !== undefined && battery <= 100 ? battery : null,
      batteryState: charging ? "Charging" : "Discharging",
      connectionType: AulaSc580HidClient.isWired(this.device) ? "Wired" : "Wireless",
      dpi: 0,
      pollingRateHz,
      supportedPollingRates: AULA_SC580_POLLING_RATES,
      activeProfile: null,
      liftOffDistance: null,
      firmware: [],
      dpiStages: stages,
      ui: { dpiStageEditor: { maxStages: STAGE_COUNT, countEditable: false, minDpi: 50, maxDpi: 12000, stepDpi: 50 } },
    };
  }

  /** `stage` is 0-based, like the other drivers. Returns the DPI read back from the mouse. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!AULA_SC580_DPI_OPTIONS.includes(dpi)) throw new Error(`DPI ${dpi} is not supported by the AULA SC580.`);
    if (!Number.isInteger(stage) || stage < 0 || stage >= STAGE_COUNT) throw new Error(`DPI stage must be between 1 and ${STAGE_COUNT}.`);
    const { header, stages } = await this.readTable();
    stages[stage] = dpi;
    await this.exchange(CMD_WRITE_DPI, encodeAulaDpiWrite(header, stages));
    const confirmed = (await this.readTable()).stages[stage]!;
    if (confirmed !== dpi) throw new Error(`AULA SC580 kept DPI ${confirmed} instead of ${dpi}.`);
    return confirmed;
  }

  /** Writes the rate bit and returns the rate read back from the mouse. */
  async setPollingRate(rate: number): Promise<number> {
    const index = AULA_SC580_POLLING_RATES.indexOf(rate);
    if (index < 0) throw new Error(`${rate} Hz is not supported by the AULA SC580.`);
    await this.exchange(CMD_WRITE_RATE, [1 << index]);
    const confirmed = await this.readPollingRate();
    if (confirmed !== rate) throw new Error(`AULA SC580 kept ${confirmed} Hz instead of ${rate} Hz.`);
    return confirmed;
  }

  /** 0 when the byte is not one of the known single-bit values. */
  private async readPollingRate(): Promise<number> {
    const [bits] = await this.exchange(CMD_READ_RATE, []);
    const index = [1, 2, 4, 8].indexOf(bits ?? 0);
    return index < 0 ? 0 : AULA_SC580_POLLING_RATES[index]!;
  }

  private readTable(): Promise<{ header: number; stages: number[] }> {
    return this.exchange(CMD_READ_DPI, []).then(decodeAulaDpiTable);
  }

  private exchange(cmd: number, data: ArrayLike<number>): Promise<Uint8Array> {
    const run = async () => {
      await this.ensureOpen();
      return this.exchangeOnce(cmd, data);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async exchangeOnce(cmd: number, data: ArrayLike<number>): Promise<Uint8Array> {
    const frame = buildAulaFrame(cmd, data);
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const reply = await this.sendAndWait(cmd, frame);
      if (reply && reply.status === 0) return reply.data;
      // 1 (busy) and 2 (asleep) are transient; seen on hardware, the same frame succeeds on retry.
      if (reply && reply.status !== 1 && reply.status !== 2) throw new Error(`AULA SC580 rejected the request (status 0x${reply.status.toString(16)}).`);
      if (reply) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
    }
    throw new Error(WAKE_MESSAGE);
  }

  private sendAndWait(cmd: number, frame: Uint8Array<ArrayBuffer>): Promise<Reply | null> {
    return new Promise((resolve, reject) => {
      const finish = (value: Reply | null) => {
        clearTimeout(timer);
        this.device.removeEventListener("inputreport", onReport);
        resolve(value);
      };
      const onReport = (event: HIDInputReportEvent) => {
        const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
        const parsed = parseAulaReply(bytes);
        if (parsed && parsed.cmd === cmd) finish(parsed);
      };
      const timer = setTimeout(() => finish(null), this.replyTimeoutMs);
      this.device.addEventListener("inputreport", onReport);
      this.device.sendReport(0, frame).catch((error) => {
        clearTimeout(timer);
        this.device.removeEventListener("inputreport", onReport);
        reject(error);
      });
    });
  }
}
