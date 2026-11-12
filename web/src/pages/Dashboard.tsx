import { useEffect, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router';
import { can } from '../App';
import { Segmented } from '../ui';
import { Today } from './Today';
import { FrontDesk } from './FrontDesk';

/** One home for everyone who sees patients: the calendar (Today or Week) on the left, what needs you on the right.
 *  A doctor gets their own day; the desk and the junior doctor get the clinic's. Someone who does both (the owner) picks which, and the pick is kept. */
export function Dashboard() {
  const { perms } = useOutletContext<any>(); const [sp] = useSearchParams();
  const doctor = can(perms, 'encounter.complete'); const both = doctor && can(perms, 'visit.write');
  const [view, setViewS] = useState<'mine' | 'desk'>(() => { try { return both && localStorage.getItem('dash.view') === 'desk' ? 'desk' : 'mine'; } catch { return 'mine'; } });
  const setView = (v: 'mine' | 'desk') => { setViewS(v); try { localStorage.setItem('dash.view', v); } catch { /* storage blocked */ } };
  const arriving = !!sp.get('arrive'); // "+ New › Check in" is desk work, whoever does it
  useEffect(() => { if (both && arriving) setView('desk'); }, [both, arriving]);
  const desk = !doctor || (both && (view === 'desk' || arriving));
  const pick = both ? <Segmented<'mine' | 'desk'> size="sm" value={desk ? 'desk' : 'mine'} onChange={setView} options={[{ value: 'mine', label: 'My patients' }, { value: 'desk', label: 'Front desk' }]} /> : null;
  return desk ? <FrontDesk lead={pick} /> : <Today lead={pick} />;
}
