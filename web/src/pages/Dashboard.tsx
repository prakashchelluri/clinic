import { useOutletContext } from 'react-router';
import { can } from '../App';
import { Today } from './Today';
import { FrontDesk } from './FrontDesk';

/** One home for everyone who sees patients: the calendar (Today or Week) on the left, what needs you on the right.
 *  A doctor (the owner too) gets the doctor's view; the desk and the junior doctor get the clinic's.
 *  Check in (header, or a patient's profile) opens on whichever view this is; each view has the check-in. */
export function Dashboard() {
  const { perms } = useOutletContext<any>();
  return can(perms, 'encounter.complete') ? <Today /> : <FrontDesk />;
}
