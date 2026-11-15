import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { db, initializeDatabase, clearData } from './database/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type VehicleMode = 'bus' | 'train';
type SeatStatus = 'available' | 'reserved' | 'processing';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

let vehicleMode: VehicleMode = 'bus';
let conflictsPrevented = 0;

class Mutex {
  private locked = false;
  private queue: Array<{ name: string; resolve: () => void }> = [];

  async acquire(name: string) {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    await new Promise<void>((resolve) => this.queue.push({ name, resolve }));
    return () => this.release();
  }

  private release() {
    const next = this.queue.shift();
    if (next) next.resolve();
    else this.locked = false;
  }

  reset() {
    this.queue.splice(0).forEach((x) => x.resolve());
    this.locked = false;
  }

  get state() {
    return {
      locked: this.locked,
      waitingQueue: this.queue.map(x => x.name)
    };
  }
}

const bookingMutex = new Mutex();

function nowTime() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function nowDateTime() {
  return new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message: string, level: string) {
  db.prepare(`
    INSERT INTO activity_logs (id, time, message, level)
    VALUES (?, ?, ?, ?)
  `).run(`LOG-${randomUUID().slice(0, 8)}`, nowTime(), message, level);
}

function createSeats(mode: VehicleMode) {
  const seats: Array<{id:string,row:number,side:string,position:number}> = [];

  if (mode === 'bus') {
    for (let row = 1; row <= 3; row++) {
      for (let pos = 1; pos <= 2; pos++) {
        seats.push({ id: `A${(row-1)*2+pos}`, row, side: 'left', position: pos });
        seats.push({ id: `B${(row-1)*2+pos}`, row, side: 'right', position: pos });
      }
    }
  } else {
    for (const [i, prefix] of ['A','B','C','D'].entries()) {
      for (let pos = 1; pos <= 4; pos++) {
        seats.push({
          id: `${prefix}${pos}`,
          row: i + 1,
          side: pos <= 2 ? 'left' : 'right',
          position: pos <= 2 ? pos : pos - 2
        });
      }
    }
  }
  return seats;
}

function resetState(mode: VehicleMode) {
  bookingMutex.reset();
  clearData();
  vehicleMode = mode;
  conflictsPrevented = 0;

  const seats = createSeats(mode);
  const insert = db.prepare(`
    INSERT INTO seats (id,row_number,side,position,status)
    VALUES (@id,@row,@side,@position,'available')
  `);
  const seed = mode === 'bus'
    ? [
        ['A5', 'Priya Nair'], ['A6', 'Vikram Patel'], ['B4', 'Sneha Sharma']
      ]
    : [
        ['B3', 'Priya Nair'], ['C2', 'Vikram Patel'], ['D4', 'Sneha Sharma']
      ];

  const tx = db.transaction(() => {
    for (const s of seats) insert.run(s);
    for (const [seatId, passengerName] of seed) {
      const id = `BK-${randomUUID().slice(0, 6).toUpperCase()}`;
      const timestamp = nowDateTime();
      db.prepare(`
        UPDATE seats SET status='reserved', passenger_name=?, booking_id=?
        WHERE id=?
      `).run(passengerName, id, seatId);
      db.prepare(`
        INSERT INTO bookings (id,passenger_name,seat_id,timestamp,status)
        VALUES (?,?,?,?,?)
      `).run(id, passengerName, seatId, timestamp, 'Confirmed');
    }
    log(`Reservation system initialized (${mode === 'bus' ? 'Bus 12-Seat' : 'Train Coach 16-Seat'})`, 'info');
  });
  tx();
}

function getState() {
  const seats = db.prepare(`
    SELECT id, row_number as row, side, position, status,
           passenger_name as passengerName, booking_id as bookingId,
           locked_by as lockedBy
    FROM seats ORDER BY row_number, position, id
  `).all();

  const bookings = db.prepare(`
    SELECT id, passenger_name as passengerName, seat_id as seatId,
           timestamp, status
    FROM bookings ORDER BY rowid DESC
  `).all();

  const logs = db.prepare(`
    SELECT id, time, message, level
    FROM activity_logs ORDER BY rowid DESC LIMIT 80
  `).all();

  const totalSeats = seats.length;
  const reservedSeats = seats.filter((s:any) => s.status === 'reserved').length;
  const availableSeats = seats.filter((s:any) => s.status === 'available').length;
  const mutex = bookingMutex.state;

  return {
    vehicleMode,
    seats,
    bookings,
    logs,
    stats: { totalSeats, availableSeats, reservedSeats, conflictsPrevented },
    mutex: {
      locked: mutex.locked,
      holder: null,
      waitingQueue: mutex.waitingQueue,
      activeStep: mutex.locked ? 'critical_section' : 'idle',
      targetSeatId: null
    }
  };
}

initializeDatabase();
resetState('bus');

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', database: 'SQLite', mutex: 'active' });
});

app.get('/api/state', (_req, res) => res.json(getState()));

app.post('/api/book', async (req, res) => {
  const passengerName = String(req.body?.passengerName || '').trim();
  const seatId = String(req.body?.seatId || '').trim().toUpperCase();
  const delay = Math.max(80, Math.min(1200, Number(req.body?.simulatedDelayMs || 420)));

  if (!passengerName || !seatId) {
    return res.status(400).json({ error: 'Passenger name and seat are required.' });
  }

  log(`Passenger ${passengerName} requested Seat ${seatId}`, 'info');
  const release = await bookingMutex.acquire(passengerName);

  try {
    log(`Mutex lock acquired (${passengerName})`, 'lock');

    const seat: any = db.prepare(`SELECT * FROM seats WHERE id=?`).get(seatId);
    if (!seat) {
      return res.status(404).json({ error: `Seat ${seatId} does not exist.` });
    }

    db.prepare(`UPDATE seats SET status='processing', locked_by=? WHERE id=?`)
      .run(passengerName, seatId);

    await sleep(Math.round(delay * 0.6));
    log(`Seat ${seatId} availability checked`, 'check');
    await sleep(Math.round(delay * 0.4));

    const bookingId = `BK-${randomUUID().slice(0, 6).toUpperCase()}`;
    const timestamp = nowDateTime();

    if (seat.status === 'available') {
      db.prepare(`
        UPDATE seats
        SET status='reserved', passenger_name=?, booking_id=?, locked_by=NULL
        WHERE id=?
      `).run(passengerName, bookingId, seatId);

      db.prepare(`
        INSERT INTO bookings (id,passenger_name,seat_id,timestamp,status)
        VALUES (?,?,?,?,?)
      `).run(bookingId, passengerName, seatId, timestamp, 'Confirmed');

      log(`Passenger ${passengerName} booking confirmed for Seat ${seatId}`, 'success');
      return res.json({
        success: true,
        booking: { id: bookingId, passengerName, seatId, timestamp, status: 'Confirmed' },
        message: `Booking confirmed for ${passengerName} on Seat ${seatId}.`,
        state: getState()
      });
    }

    // Because the mutex serializes requests, the second request reaches this
    // point only after the first request has already changed the seat to reserved.
    db.prepare(`UPDATE seats SET status=?, locked_by=NULL WHERE id=?`)
      .run(seat.status, seatId);

    conflictsPrevented += 1;
    db.prepare(`
      INSERT INTO bookings (id,passenger_name,seat_id,timestamp,status)
      VALUES (?,?,?,?,?)
    `).run(bookingId, passengerName, seatId, timestamp, 'Conflict Prevented');

    log(`Passenger ${passengerName} booking rejected — Seat ${seatId} already reserved`, 'error');

    return res.json({
      success: false,
      booking: { id: bookingId, passengerName, seatId, timestamp, status: 'Conflict Prevented' },
      message: `Seat ${seatId} is already reserved.`,
      state: getState()
    });
  } finally {
    log('Mutex lock released', 'release');
    release();
  }
});

app.post('/api/cancel', async (req, res) => {
  const bookingId = String(req.body?.bookingId || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'Booking ID is required.' });

  const release = await bookingMutex.acquire('System Cancel');
  try {
    const booking: any = db.prepare(`
      SELECT * FROM bookings WHERE id=? AND status='Confirmed'
    `).get(bookingId);

    if (!booking) return res.status(404).json({ error: 'Confirmed booking not found.' });

    db.prepare(`
      UPDATE seats
      SET status='available', passenger_name=NULL, booking_id=NULL, locked_by=NULL
      WHERE id=?
    `).run(booking.seat_id);

    db.prepare(`UPDATE bookings SET status='Cancelled' WHERE id=?`).run(bookingId);
    log(`Booking ${bookingId} cancelled — Seat ${booking.seat_id} is now Available`, 'cancel');

    return res.json({ success: true, state: getState() });
  } finally {
    release();
  }
});

app.post('/api/reset', (_req, res) => {
  resetState(vehicleMode);
  res.json(getState());
});

app.post('/api/vehicle', (req, res) => {
  const mode: VehicleMode = req.body?.mode === 'train' ? 'train' : 'bus';
  resetState(mode);
  res.json(getState());
});

// Optional: Serve built frontend if available
const frontendDistCandidates = [
  path.resolve(__dirname, '../../frontend/dist'),
  path.resolve(__dirname, '../frontend/dist'),
  path.resolve(process.cwd(), 'frontend/dist'),
  path.resolve(process.cwd(), '../frontend/dist')
];

for (const distCandidate of frontendDistCandidates) {
  if (fs.existsSync(distCandidate) && fs.existsSync(path.join(distCandidate, 'index.html'))) {
    app.use(express.static(distCandidate));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(distCandidate, 'index.html'));
    });
    break;
  }
}

const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Backend server listening on http://${HOST}:${PORT}`);
});
