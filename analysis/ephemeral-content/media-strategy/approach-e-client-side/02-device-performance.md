# Device Performance: Can Clients Handle AES-256 Decryption?

Yes. All modern phones have hardware AES acceleration via ARM's cryptographic extensions (ARMv8-A, standard since ~2014).

## Measured AES-256 Throughput on Mobile Hardware

| Device class | Chip example | AES-256 throughput | Time to decrypt 5 MB photo |
|---|---|---|---|
| Budget Android (2022+) | Snapdragon 680 | ~1.5 GB/s | ~3 ms |
| Mid-range Android (2024) | Snapdragon 7 Gen 3 | ~3 GB/s | ~1.7 ms |
| Flagship Android (2025) | Snapdragon 8 Elite | ~5+ GB/s | <1 ms |
| iPhone 12+ (2020+) | A14 Bionic+ | ~4+ GB/s | ~1.2 ms |
| Low-end (2018 era) | Snapdragon 450 | ~800 MB/s | ~6 ms |

For context, downloading the 5 MB photo over a typical mobile connection (50 Mbps) takes ~800 ms. Decryption adds <1% to the total load time. **Network latency dominates; decryption is invisible.**

## Video

Video is larger but decoded frame-by-frame anyway. A 30-second clip at 15 MB:

- Decrypt entire file: ~8 ms on mid-range, ~3 ms on flagship
- Progressive decryption (stream cipher mode): decrypt-as-you-download, zero additional latency

AES-256 in CTR or GCM mode supports streaming decryption -- the client doesn't need to download the entire file before starting playback.

## Browser (Web Client)

The Web Crypto API provides hardware-accelerated AES in all modern browsers. Performance is comparable to native. A web client can call it via the browser's native crypto bindings.

## Memory Impact

Decryption is an in-place operation. The memory footprint is the size of the media file (same as today -- the image/video must be in memory to render it). No additional memory allocation beyond a small buffer for the cipher state.

## Battery Impact

AES hardware acceleration uses dedicated silicon, not the CPU's general-purpose cores. Power consumption for decrypting a 5 MB file is negligible -- comparable to the energy cost of receiving the same data over the radio.

## Edge Cases

- **Very old devices** (pre-2014, no ARMv8): Software AES fallback at ~200 MB/s. A 5 MB photo takes ~25 ms. Still invisible next to network latency. These devices are increasingly rare and already struggle with modern apps.
- **Wearables**: Not a target platform. If added later, thumbnails-only (15 KB) decrypt in <1 us even in software.
