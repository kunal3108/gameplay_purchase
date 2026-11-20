import type { WeaponId } from '../types/game';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  price: number;
  description: string;
}

export const WEAPON_CATALOGUE: readonly WeaponDef[] = [
  { id: 'pistol',  name: 'Pistol',    price: 0,   description: 'Rapid single shot' },
  { id: 'shotgun', name: 'Shotgun',   price: 300, description: '5-pellet spread'   },
  { id: 'laser',   name: 'Laser Gun', price: 500, description: 'Continuous beam'   },
];
