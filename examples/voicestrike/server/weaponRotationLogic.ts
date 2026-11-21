/**
 * Pure helper for cycling through owned weapons via keyboard.
 * Used by GameScene.rotateWeapon(); tested in isolation here.
 */

/**
 * Returns the weapon ID that is `direction` steps from `currentId`
 * in `ownedIds`. Returns null if cycling is not possible (0 or 1 weapons).
 *
 * @param ownedIds  Ordered list of owned weapon IDs (e.g. ['pistol', 'shotgun'])
 * @param currentId Currently equipped weapon ID
 * @param direction +1 = forward, -1 = backward
 */
export function getRotatedWeaponId(
  ownedIds: string[],
  currentId: string,
  direction: 1 | -1,
): string | null {
  if (ownedIds.length <= 1) return null;
  const idx = ownedIds.indexOf(currentId);
  const startIdx = idx >= 0 ? idx : 0;
  const nextIdx = (startIdx + direction + ownedIds.length) % ownedIds.length;
  return ownedIds[nextIdx] ?? null;
}
