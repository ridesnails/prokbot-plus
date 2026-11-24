import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Grok Bot 1.2.3 universal helper: Swift Array<String> backing the stdio
// peer policy, one entry in each architecture. The UID/signature checks stay intact.
// The Apple Silicon and Intel downloads carry separately signed builds of the same
// universal helper, with the team at the same offsets.
const digests = new Set([
  '2fc251e6eed8979a34c3ac3a189cce4c9dac6f02bf89a268906148ff3673da03', // darwin-arm64 DMG
  'ef652bb9d4ede71ebb0f2caf756377a0760bba3659744a16b2ac3a7ad94e2f11', // darwin-x64 DMG
]);
const teamOffsets = [0x256f68, 0x6bdb18];
export async function patchNativeHelperTeam(filename, teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('Computer helper requires a certificate Team ID');
  const bytes = await readFile(filename);
  if (!digests.has(createHash('sha256').update(bytes).digest('hex'))) throw new Error('Unsupported computer helper binary');
  for (const offset of teamOffsets) {
    if (bytes.subarray(offset, offset + 10).toString() !== 'DCNK4UB866' || bytes[offset + 15] !== 0xea)
      throw new Error('Computer helper peer policy fingerprint mismatch');
    bytes.write(teamId, offset, 'ascii');
  }
  await writeFile(filename, bytes);
  return { trustedTeam: teamId, architectures: ['x86_64', 'arm64'], sameUserRequired: true, signatureRequired: true };
}
