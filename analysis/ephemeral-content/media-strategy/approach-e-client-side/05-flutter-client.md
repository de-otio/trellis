# Consumer Client Changes

The consumer client needs a custom media loading pipeline that fetches a key, downloads encrypted bytes, and decrypts before rendering. This is the most significant client-side change. The examples below use Flutter/Dart, the reference client stack; other client stacks follow the same pattern.

## Architecture

```
PostWidget
  |
  +--> EncryptedImageProvider(mediaUrl, postId)
         |
         +--> KeyCache.getKey(postId)
         |      |
         |      +--> (cache hit) return DEK
         |      +--> (cache miss) GET /api/posts/{id}/media-key --> cache + return DEK
         |
         +--> HttpClient.get(mediaUrl)  --> encrypted bytes from the CDN
         |
         +--> AesCrypto.decrypt(bytes, dek, iv, authTag)  --> plaintext bytes
         |
         +--> ImageCodec.decode(plaintext)  --> rendered image
```

## Key Components

### 1. KeyCache

In-memory cache of DEKs, keyed by post ID. Shared across all media on the same post.

```dart
class MediaKeyCache {
  final Map<String, _CachedKey> _cache = {};
  final ApiClient _api;

  Future<Uint8List> getKey(String postId) async {
    final cached = _cache[postId];
    if (cached != null && !cached.isExpired) return cached.dek;

    final response = await _api.getMediaKey(postId);
    _cache[postId] = _CachedKey(
      dek: response.dek,
      expiresAt: DateTime.now().add(Duration(seconds: response.expiresIn)),
    );
    return response.dek;
  }

  // Batch variant for feed rendering
  Future<void> prefetchKeys(List<String> postIds) async {
    final missing = postIds.where((id) => !_cache.containsKey(id) || _cache[id]!.isExpired);
    if (missing.isEmpty) return;
    final response = await _api.batchGetMediaKeys(missing.toList());
    for (final entry in response.entries) {
      if (entry.value != null) {
        _cache[entry.key] = _CachedKey(dek: entry.value!, ...);
      }
    }
  }

  void clear() => _cache.clear();
}
```

### 2. AesCrypto

Platform-native AES-256-GCM decryption. Uses hardware acceleration.

**Mobile (iOS/Android):**
Use the `cryptography` package (Dart), which delegates to platform-native implementations (CommonCrypto on iOS, Android Keystore/BoringSSL on Android).

```dart
import 'package:cryptography/cryptography.dart';

class AesCrypto {
  static final _algorithm = AesGcm.with256bits();

  static Future<Uint8List> decrypt(Uint8List blob, Uint8List dek) async {
    // Blob format: [12 bytes IV][16 bytes auth tag][ciphertext]
    final iv = blob.sublist(0, 12);
    final authTag = blob.sublist(12, 28);
    final ciphertext = blob.sublist(28);

    final secretKey = SecretKey(dek);
    final secretBox = SecretBox(
      ciphertext,
      nonce: iv,
      mac: Mac(authTag),
    );

    final plaintext = await _algorithm.decrypt(secretBox, secretKey: secretKey);
    return Uint8List.fromList(plaintext);
  }
}
```

**Web:**
Use the Web Crypto API for hardware-accelerated AES in the browser. The `cryptography` package already supports this transparently.

### 3. EncryptedImageProvider

Custom `ImageProvider` that integrates decryption into the framework's image loading pipeline.

```dart
class EncryptedImageProvider extends ImageProvider<EncryptedImageProvider> {
  final String mediaUrl;
  final String postId;
  final MediaKeyCache keyCache;

  @override
  ImageStreamCompleter loadImage(EncryptedImageProvider key, ImageDecoderCallback decode) {
    return MultiFrameImageStreamCompleter(
      codec: _loadAndDecrypt(decode),
      scale: 1.0,
    );
  }

  Future<ui.Codec> _loadAndDecrypt(ImageDecoderCallback decode) async {
    // 1. Fetch key (likely cache hit)
    final dek = await keyCache.getKey(postId);

    // 2. Download encrypted bytes from the CDN
    final encryptedBytes = await httpClient.get(Uri.parse(mediaUrl));

    // 3. Decrypt
    final plaintext = await AesCrypto.decrypt(encryptedBytes, dek);

    // 4. Decode image
    final buffer = await ui.ImmutableBuffer.fromUint8List(plaintext);
    return decode(buffer);
  }
}
```

### 4. EncryptedVideoPlayer

For video, the approach depends on file size:

**Short videos (< 50 MB):** Download entire encrypted file, decrypt in memory, play from memory. Decryption takes <25 ms even on budget devices.

**Long videos (> 50 MB):** Streaming decryption using AES-256-CTR mode (or chunked GCM). Decrypt chunks as they download, feed to the video player's buffer. Requires a streaming decryption pipeline -- more complex but avoids loading the entire video into memory.

For launch, short-video-only support is likely sufficient. Streaming decryption can be added later.

## Feed Rendering Optimisation

A feed page shows 10-20 posts, each with 1-4 media items. Without optimisation, this could mean 20 sequential key fetches + 80 media downloads.

### Strategy

1. **Batch key prefetch**: When the feed loads, batch-fetch keys for all visible posts in one API call
2. **Parallel media download**: Download encrypted media files in parallel (the HTTP client handles this)
3. **Lazy decryption**: Decrypt only when the image enters the viewport (standard lazy loading, just with a decrypt step)
4. **Thumbnail priority**: Fetch and decrypt thumbnails first (15 KB, <1 ms decrypt), load full-size on tap

### Expected Timeline for a Feed Page

| Step | Time | Notes |
|---|---|---|
| Batch key fetch | ~100 ms | One API call, ~2 KB response |
| Thumbnail downloads (20 posts, parallel) | ~200 ms | 15 KB each, CDN edge |
| Thumbnail decryptions (20 posts) | ~1 ms total | Negligible |
| Full image on tap | ~800 ms | 200 KB optimized, CDN edge + ~0.1 ms decrypt |

Total perceived load time is dominated by network, not decryption. **Users won't notice the encryption.**

## Plaintext Fallback

During migration from plaintext to encrypted media, the client must handle both:

```dart
if (mediaFile.isEncrypted) {
  // Encrypted path: fetch key, download, decrypt, render
} else {
  // Legacy path: direct CDN URL (current behaviour)
}
```

The `MediaFile` model in the API response includes an `encrypted` flag (or the client checks for the `.enc` extension).
