/**
 * Tiny dependency-free QR Code generator (ISO/IEC 18004) → SVG.
 * Byte mode, versions 1–10, error correction L/M/Q/H, automatic mask selection.
 * Based on the reference algorithm structure popularised by Project Nayuki (MIT).
 *
 *   window.OdexQR.toSvg(text, { ecc: 'M', border: 4, dark: '#000', light: '#fff' })
 */
(function () {
  const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  const ECC_CODEWORDS_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
  };
  const NUM_EC_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
  };
  const MAX_VERSION = 10;

  function numRawDataModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const na = Math.floor(ver / 7) + 2;
      r -= (25 * na - 10) * na - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }

  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_EC_BLOCKS[ecl][ver];
  }

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => {
        result[i] ^= gfMul(coef, factor);
      });
    }
    return result;
  }

  function encodeData(bytes, ecl) {
    for (let ver = 1; ver <= MAX_VERSION; ver++) {
      const cap = numDataCodewords(ver, ecl) * 8;
      const ccBits = ver <= 9 ? 8 : 16;
      const used = 4 + ccBits + bytes.length * 8;
      if (used > cap) continue;
      const bits = [];
      const push = (val, len) => {
        for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
      };
      push(0x4, 4);
      push(bytes.length, ccBits);
      for (const b of bytes) push(b, 8);
      push(0, Math.min(4, cap - bits.length));
      push(0, (8 - (bits.length % 8)) % 8);
      for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8);
      const codewords = [];
      for (let i = 0; i < bits.length; i += 8) {
        let v = 0;
        for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
        codewords.push(v);
      }
      return { ver, codewords };
    }
    throw new Error('Text too long for QR version 10');
  }

  function addEccAndInterleave(data, ver, ecl) {
    const numBlocks = NUM_EC_BLOCKS[ecl][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const div = rsDivisor(blockEccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
      });
    }
    return result;
  }

  function alignmentPositions(ver, size) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function build(text, ecl = 'M') {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    const { ver, codewords } = encodeData(bytes, ecl);
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, dark) => {
      modules[y][x] = dark;
      isFn[y][x] = true;
    };

    // Timing patterns
    for (let i = 0; i < size; i++) {
      setFn(6, i, i % 2 === 0);
      setFn(i, 6, i % 2 === 0);
    }
    // Finder patterns + separators
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(x, y, d !== 2 && d !== 4);
        }
      }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    // Alignment patterns
    const ap = alignmentPositions(ver, size);
    for (let i = 0; i < ap.length; i++) {
      for (let j = 0; j < ap.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    // Format bits (placeholder, reserves the area) and version bits
    const drawFormat = (mask) => {
      const data = (ECC_FORMAT_BITS[ecl] << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;
      const bit = (i) => ((bits >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
      setFn(8, 7, bit(6));
      setFn(8, 8, bit(7));
      setFn(7, 8, bit(8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
      setFn(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const b = ((bits >>> i) & 1) !== 0;
        const a = size - 11 + (i % 3);
        const c = Math.floor(i / 3);
        setFn(a, c, b);
        setFn(c, a, b);
      }
    }

    // Data
    const all = addEccAndInterleave(codewords, ver, ecl);
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && bi < all.length * 8) {
            modules[y][x] = ((all[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0;
            bi++;
          }
        }
      }
    }

    const maskFn = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const applyMask = (m) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && maskFn[m](x, y)) modules[y][x] = !modules[y][x];
    };
    const penalty = () => {
      let p = 0;
      const lines = [];
      for (let i = 0; i < size; i++) {
        lines.push(modules[i]);
        lines.push(modules.map((row) => row[i]));
      }
      for (const line of lines) {
        let run = 1;
        for (let i = 1; i <= line.length; i++) {
          if (i < line.length && line[i] === line[i - 1]) run++;
          else {
            if (run >= 5) p += 3 + (run - 5);
            run = 1;
          }
        }
        const s = line.map((v) => (v ? '1' : '0')).join('');
        let idx = -1;
        while ((idx = s.indexOf('1011101', idx + 1)) !== -1) {
          const before = s.slice(Math.max(0, idx - 4), idx);
          const after = s.slice(idx + 7, idx + 11);
          if ((idx < 4 || before === '0000') || (idx + 11 > s.length || after === '0000')) p += 40;
        }
      }
      for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
          const c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) p += 3;
        }
      }
      let dark = 0;
      modules.forEach((row) => row.forEach((v) => (dark += v ? 1 : 0)));
      const total = size * size;
      p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
      return p;
    };

    let best = 0;
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      const score = penalty();
      if (score < bestScore) {
        best = m;
        bestScore = score;
      }
      applyMask(m);
    }
    applyMask(best);
    drawFormat(best);
    return { size, modules, version: ver, mask: best };
  }

  function toSvg(text, { ecc = 'M', border = 4, dark = '#000000', light = '#ffffff' } = {}) {
    const { size, modules } = build(text, ecc);
    const dim = size + border * 2;
    let path = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (modules[y][x]) path += `M${x + border},${y + border}h1v1h-1z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
  }

  const api = { build, toSvg };
  if (typeof window !== 'undefined') window.OdexQR = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
