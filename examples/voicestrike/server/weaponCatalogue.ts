/** Server-side mirror of the client's ShopCatalogue — same IDs and prices. */
export interface WeaponDef {
  id: string;
  name: string;
  price: number;
}

export const WEAPON_CATALOGUE: readonly WeaponDef[] = [
  { id: 'pistol',  name: 'Pistol',    price: 0   },
  { id: 'shotgun', name: 'Shotgun',   price: 300 },
  { id: 'laser',   name: 'Laser Gun', price: 500 },
];
