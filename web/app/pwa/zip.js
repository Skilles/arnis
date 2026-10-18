/*
 * A minimal ZIP writer for downloading world folders.
 *
 * Entries are stored without compression: a Minecraft world is mostly region
 * files whose chunks are already zlib-compressed, so deflating them again
 * would cost time on a phone for almost no gain. Each entry is streamed in
 * chunks with a data descriptor, so no file has to be held whole, and the
 * result is a Blob the browser can keep on disk rather than in memory.
 *
 * Limits: no ZIP64, so the archive and every entry must stay under 4 GiB.
 */
(function () {
  'use strict';

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32Update(crc, bytes) {
    let c = crc ^ 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  const LIMIT = 0xffffffff;

  class ZipWriter {
    constructor() {
      this.parts = [];
      this.central = [];
      this.offset = 0;
      this.stamp = dosDateTime(new Date());
      this.encoder = new TextEncoder();
    }

    push(bytes) {
      this.parts.push(bytes);
      this.offset += bytes.length;
      if (this.offset > LIMIT) {
        throw new Error('This world is larger than 4 GB, which this download format cannot hold.');
      }
    }

    /**
     * Adds one file. `chunks` is an async iterable of Uint8Array.
     */
    async addFile(name, chunks) {
      const nameBytes = this.encoder.encode(name);
      const headerOffset = this.offset;

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); // local file header
      local.setUint16(4, 20, true); // version needed
      local.setUint16(6, 0x0808, true); // data descriptor + UTF-8 names
      local.setUint16(8, 0, true); // stored
      local.setUint16(10, this.stamp.time, true);
      local.setUint16(12, this.stamp.day, true);
      // CRC and sizes follow in the data descriptor.
      local.setUint16(26, nameBytes.length, true);
      this.push(new Uint8Array(local.buffer));
      this.push(nameBytes);

      let crc = 0;
      let size = 0;
      for await (const chunk of chunks) {
        crc = crc32Update(crc, chunk);
        size += chunk.length;
        this.push(chunk);
      }

      const descriptor = new DataView(new ArrayBuffer(16));
      descriptor.setUint32(0, 0x08074b50, true);
      descriptor.setUint32(4, crc, true);
      descriptor.setUint32(8, size, true);
      descriptor.setUint32(12, size, true);
      this.push(new Uint8Array(descriptor.buffer));

      this.central.push({ nameBytes, crc, size, headerOffset });
    }

    /** Finishes the archive and returns it as a Blob. */
    finish() {
      const start = this.offset;
      for (const entry of this.central) {
        const header = new DataView(new ArrayBuffer(46));
        header.setUint32(0, 0x02014b50, true); // central directory header
        header.setUint16(4, 20, true); // version made by
        header.setUint16(6, 20, true); // version needed
        header.setUint16(8, 0x0808, true);
        header.setUint16(10, 0, true);
        header.setUint16(12, this.stamp.time, true);
        header.setUint16(14, this.stamp.day, true);
        header.setUint32(16, entry.crc, true);
        header.setUint32(20, entry.size, true);
        header.setUint32(24, entry.size, true);
        header.setUint16(28, entry.nameBytes.length, true);
        header.setUint32(42, entry.headerOffset, true);
        this.push(new Uint8Array(header.buffer));
        this.push(entry.nameBytes);
      }
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); // end of central directory
      end.setUint16(8, this.central.length, true);
      end.setUint16(10, this.central.length, true);
      end.setUint32(12, this.offset - start, true);
      end.setUint32(16, start, true);
      this.push(new Uint8Array(end.buffer));
      return new Blob(this.parts, { type: 'application/zip' });
    }
  }

  self.ArnisZip = { ZipWriter, crc32Update };
})();
