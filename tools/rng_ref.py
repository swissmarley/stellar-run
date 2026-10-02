"""Independent reference implementation of the core PRNG/hash (Python stdlib only).
Produces golden vectors for tests/unit/det.test.ts. Run: python3 tools/rng_ref.py"""
M = 0xFFFFFFFF

def rotl(x, k):
    return ((x << k) | (x >> (32 - k))) & M

class Rng:
    def __init__(self, seed):
        self.sm = seed & M
        self.s = [self.splitmix() for _ in range(4)]
        if not any(self.s):
            self.s[0] = 1
    def splitmix(self):
        self.sm = (self.sm + 0x9E3779B9) & M
        z = self.sm
        z = ((z ^ (z >> 16)) * 0x85EBCA6B) & M
        z = ((z ^ (z >> 13)) * 0xC2B2AE35) & M
        return (z ^ (z >> 16)) & M
    def next(self):
        s0, s1, s2, s3 = self.s
        result = (rotl((s1 * 5) & M, 7) * 9) & M
        t = (s1 << 9) & M
        s2 ^= s0
        s3 ^= s1
        s1 ^= s2
        s0 ^= s3
        s2 ^= t
        s3 = rotl(s3, 11)
        self.s = [s0, s1, s2, s3]
        return result

FNV_OFFSET = 0x811C9DC5
FNV_PRIME = 0x01000193

def fnv_word(h, w):
    for sh in (0, 8, 16, 24):
        h = ((h ^ ((w >> sh) & 0xFF)) * FNV_PRIME) & M
    return h

def fmix32(h):
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & M
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & M
    h ^= h >> 16
    return h

def hash32(a, b=0, c=0):
    h = FNV_OFFSET
    for w in (a, b, c):
        h = fnv_word(h, w & M)
    return fmix32(h)

if __name__ == '__main__':
    for seed in (0, 1, 42, 0xDEADBEEF):
        r = Rng(seed)
        print(seed, [r.next() for _ in range(6)])
    print('hash', [hash32(1, 2, 3), hash32(0), hash32(0xFFFFFFFF, 7, 9), hash32(12345, 678, 1)])
