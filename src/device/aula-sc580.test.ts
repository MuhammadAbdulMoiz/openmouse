import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  AULA_SC580_DPI_OPTIONS, AulaSc580HidClient, aulaDpiFromRaw, aulaRawFromDpi, buildAulaFrame, decodeAulaDpiTable, encodeAulaDpiWrite, parseAulaReply,
} from "./aula-sc580.ts";
import { clientSupportScore, createSupportedClient, listLogicalDevices } from "./device-clients.ts";

const hex = (text: string) => Uint8Array.from(text.replace(/\s+/g, "").match(/../g)!.map((byte) => parseInt(byte, 16)));
const pad = (text: string) => { const out = new Uint8Array(32); out.set(hex(text)); return out; };

const WRITE_FRAME = hex("03 00 01 1b 00 16 10 00 00 00 26 00 00 00 30 00 00 00 40 00 00 00 80 00 00 00 dc 00 00 00 00 18");
const READ_REPLY = hex("13 00 01 19 16 10 00 00 00 26 00 00 00 30 00 00 00 40 00 00 00 80 00 00 00 dc 00 00 00 00 00 18");
const IDENTIFY_REPLY = (() => { const r = pad("30 00 01 0b 4d 31 33 37 01 16 11 aa 00 3e 01"); r[31] = 0xf9; return r; })();
const STAGES = [800, 1900, 2400, 3200, 6400, 12000];

interface FakeDevice extends HIDDevice { sent: Uint8Array[]; push(payload: Uint8Array): void }

function fakeDevice(usagePage = 0xff02, respond?: (frame: Uint8Array, device: FakeDevice) => void): FakeDevice {
  const target = new EventTarget();
  const device = {
    productName: "Wireless-Receiver",
    vendorId: 0x089d,
    productId: 0x062f,
    collections: [{ usagePage, usage: 0, children: [], inputReports: [], outputReports: [], featureReports: [] }],
    opened: false,
    sent: [] as Uint8Array[],
    open: async () => { device.opened = true; },
    close: async () => { device.opened = false; },
    sendReport: async (_id: number, data: BufferSource) => {
      assert.ok(device.opened, "sendReport on a closed device");
      const frame = new Uint8Array(data as Uint8Array);
      device.sent.push(frame);
      setTimeout(() => respond?.(frame, device), 0);
    },
    addEventListener: (type: string, fn: EventListener) => target.addEventListener(type, fn),
    removeEventListener: (type: string, fn: EventListener) => target.removeEventListener(type, fn),
    push: (payload: Uint8Array) => {
      const event = Object.assign(new Event("inputreport"), { reportId: 0, data: new DataView(payload.buffer.slice(0) as ArrayBuffer) });
      target.dispatchEvent(event);
    },
  };
  return device as unknown as FakeDevice;
}

/** A device that behaves like the mouse: identify, table read and echoed write. */
function mouse(stages = [...STAGES], rate = { bits: 0x02 }) {
  return fakeDevice(0xff02, (frame, device) => {
    if (frame[0] === 0x30) device.push(IDENTIFY_REPLY);
    else if (frame[0] === 0x12) device.push(buildAulaFrame(0x12, [rate.bits]));
    else if (frame[0] === 0x02) { rate.bits = frame[4]!; device.push(frame); }
    else if (frame[0] === 0x13) {
      const data = [0x16, ...stages.flatMap((dpi) => [aulaRawFromDpi(dpi), 0, 0, 0])];
      device.push(buildAulaFrame(0x13, data));
    } else if (frame[0] === 0x03) {
      for (let i = 0; i < 6; i += 1) stages[i] = aulaDpiFromRaw(frame[4 + 2 + i * 4]!);
      device.push(frame);
    }
  });
}

const fast = { replyTimeoutMs: 20, retries: 3, retryDelayMs: 1 };

describe("aula frames", () => {
  test("write frame matches the vendor capture byte for byte", () => {
    assert.deepEqual(buildAulaFrame(0x03, encodeAulaDpiWrite(0x16, STAGES)), WRITE_FRAME);
  });

  test("identify request", () => {
    assert.deepEqual(buildAulaFrame(0x30), pad("30 00 01 00"));
  });

  test("parses captured replies, echoes and rejects a bad checksum", () => {
    const table = parseAulaReply(READ_REPLY)!;
    assert.equal(table.cmd, 0x13);
    assert.equal(table.status, 0);
    assert.equal(table.data.length, 25);
    assert.deepEqual(decodeAulaDpiTable(table.data), { header: 0x16, stages: STAGES });
    assert.deepEqual([...parseAulaReply(IDENTIFY_REPLY)!.data.slice(0, 4)], [0x4d, 0x31, 0x33, 0x37]);
    const echo = buildAulaFrame(0x13);
    echo[1] = 0x02;
    echo[31] = 0x77;
    assert.equal(parseAulaReply(echo)!.status, 2);
    const bad = READ_REPLY.slice();
    bad[31] ^= 0xff;
    assert.equal(parseAulaReply(bad), null);
    assert.equal(parseAulaReply(new Uint8Array(10)), null);
  });

  test("stage bytes switch to 100 DPI steps above 10000", () => {
    for (const [raw, dpi] of [[1, 50], [16, 800], [200, 10000], [201, 10100], [0xdc, 12000]]) {
      assert.equal(aulaDpiFromRaw(raw!), dpi);
      assert.equal(aulaRawFromDpi(dpi!), raw);
    }
    for (const dpi of AULA_SC580_DPI_OPTIONS) assert.equal(aulaDpiFromRaw(aulaRawFromDpi(dpi)), dpi);
  });

  test("DPI grid", () => {
    assert.equal(AULA_SC580_DPI_OPTIONS[0], 50);
    assert.equal(AULA_SC580_DPI_OPTIONS.at(-1), 12000);
    assert.ok(AULA_SC580_DPI_OPTIONS.includes(10100));
    assert.ok(!AULA_SC580_DPI_OPTIONS.includes(10050));
  });
});

describe("aula support", () => {
  test("isSupported needs the vendor pair and the 0xff02 collection", () => {
    assert.equal(AulaSc580HidClient.isSupported(fakeDevice(0xff02)), true);
    assert.equal(AulaSc580HidClient.isSupported(fakeDevice(0xff01)), false);
    assert.equal(AulaSc580HidClient.isSupported({ ...fakeDevice(0xff02), vendorId: 0x1234 } as unknown as HIDDevice), false);
  });
});

describe("aula client", () => {
  test("opens the device first and reads status without inventing an active stage", async () => {
    const device = mouse();
    const status = await new AulaSc580HidClient(device, fast).readStatus();
    assert.equal(device.opened, true);
    assert.deepEqual(status.dpiStages, STAGES);
    assert.equal(status.dpi, 0);
    assert.equal("activeDpiStage" in status, false);
    assert.equal(status.batteryPercent, 0x3e);
    assert.equal(status.batteryState, "Unknown");
    assert.equal(status.pollingRateHz, 250);
    assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  });

  test("setPollingRate writes the vendor's rate bit and confirms it", async () => {
    const rate = { bits: 0x02 };
    const device = mouse(undefined, rate);
    assert.equal(await new AulaSc580HidClient(device, fast).setPollingRate(1000), 1000);
    assert.deepEqual(device.sent[0], pad("02 00 01 01 08").fill(0x08, 31));
    assert.equal(rate.bits, 0x08);
    await assert.rejects(new AulaSc580HidClient(mouse(), fast).setPollingRate(2000), /not supported/);
  });

  test("an unknown rate byte reads as 0 rather than a guess", async () => {
    const status = await new AulaSc580HidClient(mouse(undefined, { bits: 0x03 }), fast).readStatus();
    assert.equal(status.pollingRateHz, 0);
  });

  for (const status of [1, 2]) {
    test(`retries after a status-${status} reply`, async () => {
      let calls = 0;
      const device = fakeDevice(0xff02, (frame, d) => {
        calls += 1;
        if (calls === 1) { const echo = frame.slice(); echo[1] = status; d.push(echo); } else d.push(IDENTIFY_REPLY);
      });
      const client = new AulaSc580HidClient(device, fast) as unknown as { exchange(c: number, d: number[]): Promise<Uint8Array> };
      assert.equal((await client.exchange(0x30, [])).length, 11);
      assert.equal(device.sent.length, 2);
    });
  }

  test("throws on any other status", async () => {
    const device = fakeDevice(0xff02, (frame, d) => { const echo = frame.slice(); echo[1] = 3; d.push(echo); });
    const client = new AulaSc580HidClient(device, fast) as unknown as { exchange(c: number, d: number[]): Promise<Uint8Array> };
    await assert.rejects(client.exchange(0x30, []), /status 0x3/);
  });

  test("times out repeatedly and throws the wake message", async () => {
    const device = fakeDevice();
    await assert.rejects(new AulaSc580HidClient(device, { ...fast, retries: 2 }).readStatus(), /Move the mouse to wake it/);
    assert.equal(device.sent.length, 3);
  });

  test("ignores unsolicited 0xd1 events", async () => {
    const device = fakeDevice(0xff02, (_frame, d) => { d.push(pad("d1 00 01 00")); d.push(IDENTIFY_REPLY); });
    const client = new AulaSc580HidClient(device, fast) as unknown as { exchange(c: number, d: number[]): Promise<Uint8Array> };
    assert.equal((await client.exchange(0x30, [])).length, 11);
  });

  test("setDpiStageValue writes the expected frame and confirms by re-reading", async () => {
    const stages = [800, 1900, 2400, 3200, 6400, 9000];
    const device = mouse(stages);
    const confirmed = await new AulaSc580HidClient(device, fast).setDpiStageValue(5, 12000);
    assert.equal(confirmed, 12000);
    assert.deepEqual(device.sent.map((frame) => frame[0]), [0x13, 0x03, 0x13]);
    assert.deepEqual(device.sent[1], WRITE_FRAME);
  });

  test("rejects off-grid DPI before touching the device", async () => {
    const device = mouse();
    await assert.rejects(new AulaSc580HidClient(device, fast).setDpiStageValue(0, 10050), /not supported/);
    assert.equal(device.sent.length, 0);
  });
});

describe("aula device-clients wiring", () => {
  test("createSupportedClient, score and logical device pick the 0xff02 collection", async () => {
    const settings = fakeDevice(0xff02);
    const sibling = fakeDevice(0xff01);
    assert.ok(await createSupportedClient(settings) instanceof AulaSc580HidClient);
    assert.ok(await clientSupportScore(settings) > await clientSupportScore(sibling));
    assert.deepEqual(await listLogicalDevices([sibling, settings]), [settings]);
  });
});
