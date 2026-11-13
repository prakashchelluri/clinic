import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router';
import './index.css';
import './glass.css';
import { qc } from './api';
import { App, Home } from './App';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';

import { Navigate } from 'react-router';
import { Patients } from './pages/Patients';
import { Encounter } from './pages/Encounter';
import { Worklist } from './pages/Worklist';
import { Reports } from './pages/Reports';
import { TestReports } from './pages/TestReports';
import { Calls } from './pages/Followups';
import { Help } from './pages/Help';
import { Clinic } from './pages/Clinic';
import { PrintRx } from './pages/PrintRx';
import { Pharmacy, InventoryPage } from './pages/Pharmacy';
import { Settings } from './pages/Settings';
import { Platform } from './pages/Platform';
import { AuditLog } from './pages/Privacy';
import { Expenses } from './pages/Expenses';
import { Accounts } from './pages/Accounts';
import { Billing } from './billing';

import { PatientLink } from './pages/PatientLink';
import { Display } from './pages/Display';
import { NotFound } from './ui';
import { useLocation, useParams } from 'react-router';

/** A fresh pad per patient: keyed on the id, nothing from patient A's pad can carry over (or autosave) into patient B's. */
function EncounterById() { return <Encounter key={useParams().id} />; }
/** An old address (Today, Front desk, Appointments, Follow-ups) goes to the page that replaced it, keeping its query (?book=1, ?arrive=1…). */
function Moved({ to, add = '' }: { to: string; add?: string }) {
  const q = new URLSearchParams(useLocation().search); new URLSearchParams(add).forEach((v, k) => q.set(k, v));
  const s = q.toString();
  return <Navigate to={s ? `${to}?${s}` : to} replace />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/print/:id" element={<PrintRx />} />
          <Route path="/a/:slug/:token" element={<PatientLink />} />
          <Route path="/display/:slug/:token" element={<Display />} />
          <Route element={<App />}>
            <Route index element={<Home />} />
            {/* ponytail: the old Overview (pages/Overview.tsx) is parked; its address, and the Dashboard's, go to Reports */}
            <Route path="/overview" element={<Navigate to="/reports" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            {['/today', '/today/week', '/queue', '/appointments', '/calendar', '/bookings'].map((p) => <Route key={p} path={p} element={<Moved to="/dashboard" />} />)}
            <Route path="/booking" element={<Moved to="/dashboard" add="book=1" />} />
            <Route path="/patients" element={<Patients />} />
            <Route path="/patients/:id" element={<Patients />} />
            <Route path="/encounter/:id" element={<EncounterById />} />
            <Route path="/worklist" element={<Worklist />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/tests" element={<TestReports />} />
            <Route path="/calls" element={<Calls />} />
            <Route path="/followups" element={<Moved to="/calls" />} />
            <Route path="/help" element={<Help />} />

            <Route path="/clinic" element={<Clinic />} />
            <Route path="/pharmacy" element={<Pharmacy />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/settings" element={<Settings />} />

            <Route path="/expenses" element={<Expenses />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/platform" element={<Platform />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
