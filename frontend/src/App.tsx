import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityLogPanel } from './components/ActivityLogPanel';
import { BookingHistoryTable } from './components/BookingHistoryTable';
import { HeaderBar } from './components/HeaderBar';
import { PassengerPanels, type SimultaneousOutcome } from './components/PassengerPanels';
import { RaceConditionPanel } from './components/RaceConditionPanel';
import { SeatMap, type SelectionTarget } from './components/SeatMap';
import { StatsStrip } from './components/StatsStrip';
import type { BookingApiResponse, SystemState, VehicleMode } from './types/reservation';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const apiUrl = (endpoint: string) => `${API_BASE}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

export default function App() {
  const [systemState, setSystemState] = useState<SystemState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [p1Name, setP1Name] = useState('Rahul Kumar');
  const [p2Name, setP2Name] = useState('Amit Singh');
  const [p1Seat, setP1Seat] = useState('A1');
  const [p2Seat, setP2Seat] = useState('A1');
  const [selectionTarget, setSelectionTarget] = useState<SelectionTarget>('both');

  const [loadingP1, setLoadingP1] = useState(false);
  const [loadingP2, setLoadingP2] = useState(false);
  const [loadingSimultaneous, setLoadingSimultaneous] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const [singleFeedback, setSingleFeedback] = useState<{
    passengerIndex: 1 | 2;
    success: boolean;
    message: string;
  } | null>(null);
  const [simultaneousOutcome, setSimultaneousOutcome] = useState<SimultaneousOutcome | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/state'));
      if (!res.ok) throw new Error('Failed to load reservation state');
      const data: SystemState = await res.json();
      setSystemState(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Unable to reach reservation server.');
    }
  }, []);

  useEffect(() => {
    fetchState();
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [fetchState]);

  const startLivePolling = () => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(() => {
      fetchState();
    }, 110);
  };

  const stopLivePolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const handleSelectSeatOnMap = (seatId: string) => {
    if (selectionTarget === 'p1') {
      setP1Seat(seatId);
    } else if (selectionTarget === 'p2') {
      setP2Seat(seatId);
    } else {
      setP1Seat(seatId);
      setP2Seat(seatId);
    }
  };

  const handleBookSingle = async (passengerIndex: 1 | 2) => {
    const passengerName = (passengerIndex === 1 ? p1Name : p2Name).trim();
    const seatId = passengerIndex === 1 ? p1Seat : p2Seat;
    if (!passengerName) return;

    setSingleFeedback(null);
    setSimultaneousOutcome(null);
    if (passengerIndex === 1) setLoadingP1(true);
    else setLoadingP2(true);

    startLivePolling();
    try {
      const res = await fetch(apiUrl('/api/book'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passengerName, seatId, simulatedDelayMs: 440 }),
      });
      const data: BookingApiResponse = await res.json();
      if (data.state) setSystemState(data.state);
      setSingleFeedback({
        passengerIndex,
        success: data.success,
        message: data.message,
      });
    } catch {
      setSingleFeedback({
        passengerIndex,
        success: false,
        message: 'Network error while attempting booking.',
      });
    } finally {
      stopLivePolling();
      await fetchState();
      if (passengerIndex === 1) setLoadingP1(false);
      else setLoadingP2(false);
    }
  };

  const handleTestSimultaneous = async () => {
    const targetSeat = p1Seat;
    setP2Seat(targetSeat);
    const name1 = p1Name.trim() || 'Passenger A';
    const name2 = p2Name.trim() || 'Passenger B';

    setSingleFeedback(null);
    setSimultaneousOutcome(null);
    setLoadingSimultaneous(true);
    startLivePolling();

    try {
      const reqA = fetch(apiUrl('/api/book'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passengerName: name1,
          seatId: targetSeat,
          simulatedDelayMs: 520,
        }),
      }).then((r) => r.json() as Promise<BookingApiResponse>);

      // Micro-offset of 15ms ensures predictable arrival order while hitting the active critical section concurrently
      const reqB = new Promise<BookingApiResponse>((resolve) => {
        setTimeout(async () => {
          const r = await fetch(apiUrl('/api/book'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              passengerName: name2,
              seatId: targetSeat,
              simulatedDelayMs: 360,
            }),
          });
          resolve((await r.json()) as BookingApiResponse);
        }, 15);
      });

      const [resA, resB] = await Promise.all([reqA, reqB]);
      setSystemState(resB.state || resA.state);

      setSimultaneousOutcome({
        seatId: targetSeat,
        firstPassenger: name1,
        firstSuccess: resA.success,
        firstMessage: resA.message,
        secondPassenger: name2,
        secondSuccess: resB.success,
        secondMessage: resB.message,
      });
    } finally {
      stopLivePolling();
      await fetchState();
      setLoadingSimultaneous(false);
    }
  };

  const handleCancelBooking = async (bookingId: string) => {
    setCancellingId(bookingId);
    try {
      const res = await fetch(apiUrl('/api/cancel'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId }),
      });
      const data = await res.json();
      if (data.state) setSystemState(data.state);
    } finally {
      setCancellingId(null);
      await fetchState();
    }
  };

  const handleVehicleModeChange = async (mode: VehicleMode) => {
    setSingleFeedback(null);
    setSimultaneousOutcome(null);
    const res = await fetch(apiUrl('/api/vehicle'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const data: SystemState = await res.json();
    setSystemState(data);
    setP1Seat('A1');
    setP2Seat('A1');
  };

  const handleResetDemo = async () => {
    setSingleFeedback(null);
    setSimultaneousOutcome(null);
    const res = await fetch(apiUrl('/api/reset'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: systemState?.vehicleMode ?? 'bus' }),
    });
    const data: SystemState = await res.json();
    setSystemState(data);
    setP1Seat('A1');
    setP2Seat('A1');
  };

  if (loadError && !systemState) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
        <div className="bg-white border border-rose-200 rounded-xl p-6 max-w-md w-full space-y-3 text-center">
          <h1 className="text-lg font-bold text-slate-900">Connection Error</h1>
          <p className="text-sm text-slate-600">{loadError}</p>
          <button
            type="button"
            onClick={fetchState}
            className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  if (!systemState) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
        <div className="text-sm font-medium text-slate-600">
          Initializing Seat Reservation System...
        </div>
      </div>
    );
  }

  const isBusy = loadingP1 || loadingP2 || loadingSimultaneous || cancellingId !== null;

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      <HeaderBar
        vehicleMode={systemState.vehicleMode}
        onVehicleModeChange={handleVehicleModeChange}
        onResetDemo={handleResetDemo}
        isBusy={isBusy}
      />

      <main className="max-w-[1440px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6 flex-1">
        <StatsStrip stats={systemState.stats} />

        {/* Main 3-Column Operational Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
          <div className="lg:col-span-3">
            <PassengerPanels
              seats={systemState.seats}
              p1Name={p1Name}
              p1Seat={p1Seat}
              p2Name={p2Name}
              p2Seat={p2Seat}
              onP1NameChange={setP1Name}
              onP1SeatChange={setP1Seat}
              onP2NameChange={setP2Name}
              onP2SeatChange={setP2Seat}
              onBookSingle={handleBookSingle}
              onTestSimultaneous={handleTestSimultaneous}
              loadingP1={loadingP1}
              loadingP2={loadingP2}
              loadingSimultaneous={loadingSimultaneous}
              singleFeedback={singleFeedback}
              simultaneousOutcome={simultaneousOutcome}
            />
          </div>

          <div className="lg:col-span-4">
            <SeatMap
              vehicleMode={systemState.vehicleMode}
              seats={systemState.seats}
              selectedSeatP1={p1Seat}
              selectedSeatP2={p2Seat}
              selectionTarget={selectionTarget}
              onSelectionTargetChange={setSelectionTarget}
              onSelectSeat={handleSelectSeatOnMap}
            />
          </div>

          <div className="lg:col-span-5 flex flex-col gap-5">
            <RaceConditionPanel
              mutex={systemState.mutex}
              p1Name={p1Name}
              p2Name={p2Name}
              targetSeat={p1Seat}
            />
            <ActivityLogPanel logs={systemState.logs} />
          </div>
        </div>

        {/* Full-Width Booking History Table */}
        <BookingHistoryTable
          bookings={systemState.bookings}
          onCancelBooking={handleCancelBooking}
          cancellingId={cancellingId}
        />
      </main>
    </div>
  );
}
