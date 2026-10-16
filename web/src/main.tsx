import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router';
import './index.css';
import { qc } from './api';
import { App, Home } from './App';
import { Overview } from './pages/Overview';
import { Today } from './pages/Today';
import { Login } from './pages/Login';
import { FrontDesk } from './pages/FrontDesk';
import { Booking } from './pages/Booking';
import { Patients } from './pages/Patients';
import { Encounter } from './pages/Encounter';
import { Worklist } from './pages/Worklist';
import { Reports } from './pages/Reports';
import { PrintRx } from './pages/PrintRx';
import { Pharmacy } from './pages/Pharmacy';
import { Settings } from './pages/Settings';
import { Calendar } from './pages/Calendar';
import { Platform } from './pages/Platform';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/print/:id" element={<PrintRx />} />
          <Route element={<App />}>
            <Route index element={<Home />} />
            <Route path="/overview" element={<Overview />} />
            <Route path="/today" element={<Today />} />
            <Route path="/queue" element={<FrontDesk />} />
            <Route path="/booking" element={<Booking />} />
            <Route path="/patients" element={<Patients />} />
            <Route path="/patients/:id" element={<Patients />} />
            <Route path="/encounter/:id" element={<Encounter />} />
            <Route path="/worklist" element={<Worklist />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/pharmacy" element={<Pharmacy />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/platform" element={<Platform />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
