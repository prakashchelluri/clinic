import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import './index.css';
import { qc } from './api';
import { App } from './App';
import { Login } from './pages/Login';
import { Queue } from './pages/Queue';
import { Booking } from './pages/Booking';
import { Patients } from './pages/Patients';
import { Encounter } from './pages/Encounter';
import { Worklist } from './pages/Worklist';
import { Reports } from './pages/Reports';
import { PrintRx } from './pages/PrintRx';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/print/:id" element={<PrintRx />} />
          <Route element={<App />}>
            <Route index element={<Navigate to="/queue" replace />} />
            <Route path="/queue" element={<Queue />} />
            <Route path="/booking" element={<Booking />} />
            <Route path="/patients" element={<Patients />} />
            <Route path="/patients/:id" element={<Patients />} />
            <Route path="/encounter/:id" element={<Encounter />} />
            <Route path="/worklist" element={<Worklist />} />
            <Route path="/reports" element={<Reports />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
