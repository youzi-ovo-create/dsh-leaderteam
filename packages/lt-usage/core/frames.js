import { parseJsonl } from './jsonl.js';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
export const DEFAULT_MAX_FRAMES = 4096;
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

function asBytes(buf) {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

function frameStarts(bytes, maxFrames) {
  const starts = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (
      bytes[i] === ZSTD_MAGIC[0] &&
      bytes[i + 1] === ZSTD_MAGIC[1] &&
      bytes[i + 2] === ZSTD_MAGIC[2] &&
      bytes[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i);
      if (starts.length > maxFrames * 4) {
        throw new Error(`splitZstdFrames: candidate frame markers exceed safety limit (${maxFrames})`);
      }
    }
  }
  if (starts.length === 0 || starts[0] !== 0) {
    throw new Error('splitZstdFrames: buffer is not a zstd stream');
  }
  return starts;
}

// 魔数也可能出现在压缩数据内部，必须用解码是否成功来确认帧边界，同时强制校验帧数与解压总字节上限以防压缩炸弹。
function sliceFrames(bytes, decompress, options = {}) {
  const maxFrames = Number.isFinite(options.maxFrames) && options.maxFrames > 0
    ? options.maxFrames
    : DEFAULT_MAX_FRAMES;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_DECOMPRESSED_BYTES;
  const starts = frameStarts(bytes, maxFrames);
  if (starts.length === 1) {
    const chunk = asBytes(decompress(bytes.subarray(0)));
    if (chunk.length > maxBytes) {
      throw new Error(`decodeSessionBytes: decompressed size ${chunk.length} exceeds limit ${maxBytes}`);
    }
    return { frames: [bytes.subarray(0)], chunks: [chunk] };
  }
  if (typeof decompress !== 'function') {
    throw new TypeError('splitZstdFrames: decompress is required to separate multiple frames');
  }
  const frames = [];
  const chunks = [];
  let totalBytes = 0;
  let s = 0;
  while (s < starts.length) {
    if (frames.length >= maxFrames) {
      throw new Error(`splitZstdFrames: frame count exceeds safety limit (${maxFrames})`);
    }
    let next = -1;
    for (let e = s + 1; e <= starts.length; e++) {
      const end = e < starts.length ? starts[e] : bytes.length;
      try {
        const chunk = asBytes(decompress(bytes.subarray(starts[s], end)));
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          throw new Error(`decodeSessionBytes: decompressed size ${totalBytes} exceeds limit ${maxBytes}`);
        }
        chunks.push(chunk);
        next = e;
        break;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('decodeSessionBytes: decompressed size')) {
          throw err;
        }
        // keep extending the boundary
      }
    }
    if (next < 0) throw new Error(`splitZstdFrames: undecodable frame at offset ${starts[s]}`);
    frames.push(bytes.subarray(starts[s], next < starts.length ? starts[next] : bytes.length));
    s = next;
  }
  return { frames, chunks };
}

export function splitZstdFrames(buf, decompress, options) {
  const bytes = asBytes(buf);
  const maxFrames = Number.isFinite(options?.maxFrames) && options.maxFrames > 0
    ? options.maxFrames
    : DEFAULT_MAX_FRAMES;
  const starts = frameStarts(bytes, maxFrames);
  if (starts.length === 1) return [bytes.subarray(0)];
  return sliceFrames(bytes, decompress, options).frames;
}

export function decodeSessionBytes(buf, decompress, options) {
  if (typeof decompress !== 'function') {
    throw new TypeError('decodeSessionBytes: decompress function is required');
  }
  const bytes = asBytes(buf);
  const { chunks } = sliceFrames(bytes, decompress, options);
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return parseJsonl(new TextDecoder().decode(merged));
}
