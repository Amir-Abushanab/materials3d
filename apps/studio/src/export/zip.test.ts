/**
 * The ZIP writer is hand-rolled (store-only, no dependency), which means nothing else checks that
 * what it produces is actually a readable archive. A corrupt zip fails silently: the file
 * downloads, and only fails when someone tries to open it.
 */
import { describe, expect, it } from "vitest";
import { createZip } from "./zip";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

async function bytesOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

describe("createZip", () => {
  it("writes the three structures a reader looks for", async () => {
    const zip = createZip([
      { name: "index.html", data: "<!doctype html><p>hi</p>" },
      { name: "project.json", data: '{"title":"x"}' },
      { name: "preview.jpg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]) },
    ]);
    const view = await bytesOf(zip);

    // Starts with a local file header.
    expect(view.getUint32(0, true)).toBe(LOCAL_HEADER);

    // Ends with an end-of-central-directory record naming three entries.
    const end = view.byteLength - 22;
    expect(view.getUint32(end, true)).toBe(END_OF_CENTRAL);
    expect(view.getUint16(end + 8, true)).toBe(3); // entries on this disk
    expect(view.getUint16(end + 10, true)).toBe(3); // entries total

    // The central directory sits where the end record says it does.
    const centralOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(CENTRAL_HEADER);
  });

  it("keeps every filename intact", async () => {
    const names = ["index.html", "project.json", "LivelyInfo.json", "preview.jpg"];
    const zip = createZip(names.map((name) => ({ name, data: name })));
    const text = new TextDecoder().decode(await zip.arrayBuffer());
    // Once in the local header, once in the central directory.
    for (const name of names) expect(text.split(name).length - 1).toBeGreaterThanOrEqual(2);
  });

  it("stores binary data byte-for-byte", async () => {
    const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const view = new Uint8Array(await createZip([{ name: "b.bin", data: payload }]).arrayBuffer());
    // Store-only: the bytes appear verbatim somewhere after the header.
    const hay = [...view].join(",");
    expect(hay).toContain([...payload].join(","));
  });
});
