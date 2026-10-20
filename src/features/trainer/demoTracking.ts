// Demo clients have no phone to encrypt their tracking on, so the server seals a
// made-up snapshot for them. Only demo users' fake data ever passes through here.
import nacl from "tweetnacl"
import type { RowDataPacket } from "mysql2"
import { pool } from "@/config/database.js"
import { storeMessage } from "./trackingRelay.model.js"

const DAY = 86_400_000

/** Fake tracking in the snapshot shape the app sends, dated back from `now`. */
export function demoTrackingSnapshot(now: number) {
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString()
  const days = (n: number, f: (i: number) => Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => ({ id: `demo-${i}`, ...f(i) }))
  return {
    sentAt: new Date(now).toISOString(),
    records: {
      body_weight: days(8, (i) => ({ weightKg: 80.2 + i * 0.3, note: i === 0 ? "Morning, fasted" : null, recordedAt: at(i * 7) })),
      body_fat: days(3, (i) => ({ percentage: 17.6 + i * 0.5, calculatedAt: at(i * 21) })),
      body_measurements: days(2, (i) => ({ waistCm: 84 + i, chestCm: 104 - i, armLeftCm: 37.5, armRightCm: 38, measuredAt: at(i * 28) })),
      custom_measurement_types: [],
      custom_measurement_values: [],
      hydration_entries: days(6, (i) => ({ amountMl: 500 + (i % 3) * 250, loggedAt: at(i * 0.5) })),
      injuries: [{ id: "demo-0", muscleGroup: "Shoulders", injuryType: "Strain", painLevel: 3, status: "recovering", startDate: at(10), note: "Overhead press aggravates it" }],
      macros_entries: days(4, (i) => ({ name: ["Oats", "Chicken and rice", "Protein shake", "Salmon"][i], calories: [380, 650, 220, 540][i], protein: [14, 52, 40, 38][i], carbs: [62, 70, 8, 20][i], fat: [8, 14, 3, 30][i], takenAt: at(i * 0.25) })),
      menstrual_entries: [],
      personal_muscle_notes: [{ id: "demo-0", muscleGroup: "Chest", content: "Incline feels stronger than flat", createdAt: at(3) }],
      progress_photos_muscle: [],
      soreness_entries: [{ id: "demo-0", muscleGroup: "Quads", intensity: 6, status: "active", loggedAt: at(1) }],
    },
    settings: {
      "@off_hydration_settings": { goalMl: 3000 },
      "@offline_macros_goals": { calories: 2500, protein: 180, carbs: 280, fat: 70 },
      "@off_menstrual_settings": null,
    },
  }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

/** Sends every demo client of `ownerId` that grants them Tracking Access a snapshot, to each of the owner's device keys. */
export async function sendDemoTracking(ownerId: number, now = Date.now()): Promise<void> {
  const [clients] = await pool.execute<(RowDataPacket & { id: number })[]>(
    `SELECT u.id FROM sharing_permissions sp JOIN users u ON u.id = sp.from_user_id
     WHERE sp.to_user_id = ? AND sp.permission_type = 'tracking' AND u.demo_owner_id = ?`,
    [ownerId, ownerId],
  )
  if (clients.length === 0) return
  const [keys] = await pool.execute<(RowDataPacket & { id: number; publicKey: string })[]>(
    `SELECT id, public_key AS publicKey FROM trainer_device_keys WHERE user_id = ?`,
    [ownerId],
  )
  const plain = new TextEncoder().encode(JSON.stringify(demoTrackingSnapshot(now)))
  for (const client of clients)
    for (const key of keys) {
      const sender = nacl.box.keyPair()
      const nonce = nacl.randomBytes(nacl.box.nonceLength)
      await storeMessage(client.id, {
        keyId: key.id,
        kind: "snapshot",
        ref: "",
        nonce: b64(nonce),
        senderKey: b64(sender.publicKey),
        ciphertext: b64(nacl.box(plain, nonce, Buffer.from(key.publicKey, "base64"), sender.secretKey)),
      })
    }
}
