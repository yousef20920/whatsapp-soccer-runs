// Mississauga indoor turf that can be booked online through Active Mississauga.
// Each venue is four quarter fields; a half field is two neighbouring quarters.
//
// Rates: City of Mississauga Schedule E-2 (May 1, 2026 – Apr 30, 2027), resident rate,
// per quarter field per hour, before 13% HST.
// https://www.mississauga.ca/wp-content/uploads/2026/01/05115541/Schedule-E-2-Recreation-Rental-Rates-Effective-May-1-2025-April-30-2026.pdf

import { weekday } from "./time.js";

export const HST = 0.13;

/** Game formats and the field size each needs. A quarter (~50×32 m) suits 5v5 up to a snug 7v7. */
export const FORMATS = {
  "11v11": { size: "full", perSide: 11 },
  "9v9": { size: "half", perSide: 9 },
  "8v8": { size: "half", perSide: 8 },
  "7v7": { size: "quarter", perSide: 7 },
  "6v6": { size: "quarter", perSide: 6 },
  "5v5": { size: "quarter", perSide: 5 },
} as const;
export type Format = keyof typeof FORMATS;

export interface Quarter {
  id: number; // Active Mississauga resource id
  label: string;
}

export interface Venue {
  name: string;
  address: string;
  /** full pitch in metres; a half is half the length, a quarter half the length and width */
  pitch: { lengthM: number; widthM: number; estimated?: boolean };
  links: { label: string; url: string }[];
  quarters: Quarter[];
  halves: [number, number][];
  /** cents per quarter field per hour, before HST */
  hourlyRateCents(ymd: string, minute: number): number;
}

/** Prime time for indoor turf ("Prime Time Turf Definition" in the rate schedule). */
export function isPrime(ymd: string, minute: number): boolean {
  const month = Number(ymd.slice(5, 7));
  const dow = weekday(ymd); // 0 = Sunday
  const between = (from: number, to: number) => minute >= from * 60 && minute < to * 60;
  if (month >= 5 && month <= 9) return dow >= 1 && dow <= 4 && between(19, 23); // May 1 – Sep 30
  if (dow >= 1 && dow <= 5) return between(18, 23); // Oct 1 – Apr 30
  if (dow === 6) return between(8, 19);
  return between(8, 23);
}

const isSummer = (ymd: string) => {
  const month = Number(ymd.slice(5, 7));
  return month >= 5 && month <= 9; // Sportsplex spring/summer season (same months as turf prime time)
};

const domeRate = (ymd: string, minute: number) => (isPrime(ymd, minute) ? 23915 : 12869);
const sportsplexRate = (ymd: string, minute: number) =>
  isSummer(ymd) ? (isPrime(ymd, minute) ? 17160 : 3655) : isPrime(ymd, minute) ? 23915 : 16827;

export const VENUES: Venue[] = [
  {
    name: "Churchill Meadows Dome",
    address: "Mattamy Sports Park, 5320 Ninth Line",
    // Pitch size isn't published; the dome itself is 367' x 243' (≈112 x 74 m), so assume a 100 x 64 m pitch.
    pitch: { lengthM: 100, widthM: 64, estimated: true },
    links: [
      { label: "Info", url: "https://www.mississauga.ca/recreation-and-sports/locations/churchill-meadows-community-centre-and-mattamy-sports-park/" },
      { label: "Tour", url: "https://www.youtube.com/watch?v=01sln1Zsu_4" },
      { label: "Map", url: "https://www.google.com/maps/search/?api=1&query=5320+Ninth+Line%2C+Mississauga%2C+ON" },
    ],
    quarters: [
      { id: 147, label: "F1" },
      { id: 119, label: "F2" },
      { id: 130, label: "F3" },
      { id: 132, label: "F4" },
    ],
    halves: [
      [147, 119],
      [130, 132],
    ],
    hourlyRateCents: domeRate,
  },
  {
    name: "Paramount Dome",
    address: "Mississauga Sports & Entertainment Centre, 5600 Rose Cherry Pl (outdoor fields)",
    pitch: { lengthM: 100, widthM: 64 },
    links: [
      { label: "Info", url: "https://www.mississauga.ca/recreation-and-sports/locations/paramount-fine-foods-centre-sportsplex/" },
      { label: "Tour", url: "https://mississaugasec.com/360-tour/" },
      { label: "Map", url: "https://www.mississaugasec.com/wp-content/uploads/2026/05/MSECrmap_visitor_26040_f.pdf" },
    ],
    quarters: [
      { id: 1192, label: "F1" },
      { id: 1197, label: "F2" },
      { id: 1196, label: "F3" },
      { id: 1181, label: "F4" },
    ],
    halves: [
      [1192, 1197],
      [1196, 1181],
    ],
    hourlyRateCents: domeRate,
  },
  {
    name: "Paramount Sportsplex",
    address: "Mississauga Sports & Entertainment Centre, 5600 Rose Cherry Pl (North Building)",
    pitch: { lengthM: 110, widthM: 64 },
    links: [
      { label: "Info", url: "https://www.mississauga.ca/recreation-and-sports/locations/paramount-fine-foods-centre-sportsplex/" },
      { label: "Tour", url: "https://mississaugasec.com/360-tour/" },
      { label: "Map", url: "https://www.mississaugasec.com/wp-content/uploads/2026/05/MSECrmap_visitor_26040_f.pdf" },
    ],
    quarters: [
      { id: 1300, label: "A" },
      { id: 1311, label: "B" },
      { id: 1314, label: "C" },
      { id: 1320, label: "D" },
    ],
    halves: [
      [1300, 1311],
      [1314, 1320],
    ],
    hourlyRateCents: sportsplexRate,
  },
];

/** "50×64 m", or "~50×64 m" when the pitch size is an estimate. */
export function dimensions(venue: Venue, size: "quarter" | "half" | "full"): string {
  const { lengthM, widthM, estimated } = venue.pitch;
  const [l, w] = size === "full" ? [lengthM, widthM] : size === "half" ? [lengthM / 2, widthM] : [lengthM / 2, widthM / 2];
  return `${estimated ? "~" : ""}${Math.round(l)}×${Math.round(w)} m`;
}

export const ALL_RESOURCE_IDS = VENUES.flatMap((v) => v.quarters.map((q) => q.id));

export const bookingLink = (resourceId: number) =>
  `https://anc.ca.apm.activecommunities.com/activemississauga/reservation/landing/search/detail/${resourceId}`;

export interface FieldCost {
  subtotalCents: number;
  hstCents: number;
  cityFeeCents: number;
  totalCents: number;
  rate: "peak" | "off-peak" | "part peak";
}

/** Cost for `quarters` quarter fields from startMinute for lengthMinutes, with the HST split out. */
/** Untaxed fee the City adds per quarter field booked when the purpose is "Soccer" (seen at checkout, Nov 2026). */
const SOCCER_FEE_CENTS_PER_FIELD = 267;

export function fieldCost(venue: Venue, ymd: string, startMinute: number, lengthMinutes: number, quarters: number): FieldCost {
  let cents = 0;
  let peakSlices = 0, slices = 0;
  for (let m = startMinute; m < startMinute + lengthMinutes; m += 15) {
    cents += (venue.hourlyRateCents(ymd, m) / 4) * quarters;
    slices++;
    if (isPrime(ymd, m)) peakSlices++;
  }
  const subtotalCents = Math.round(cents);
  const hstCents = Math.round(subtotalCents * HST);
  const rate = peakSlices === 0 ? "off-peak" : peakSlices === slices ? "peak" : "part peak";
  const cityFeeCents = SOCCER_FEE_CENTS_PER_FIELD * quarters;
  return { subtotalCents, hstCents, cityFeeCents, totalCents: subtotalCents + hstCents + cityFeeCents, rate };
}

/** The venue that owns these quarter fields, if they all belong to one venue. */
export function venueFor(resourceIds: number[]): Venue | undefined {
  const venue = VENUES.find((v) => v.quarters.some((q) => q.id === resourceIds[0]));
  return venue && resourceIds.every((id) => venue.quarters.some((q) => q.id === id)) ? venue : undefined;
}

export const sizeFor = (fieldCount: number) => (fieldCount === 4 ? "full" : fieldCount === 2 ? "half" : "quarter");

export const DEFAULT_FORMAT = { quarter: "6v6", half: "9v9", full: "11v11" } as const;
