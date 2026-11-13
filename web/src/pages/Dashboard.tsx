import { useOutletContext, useSearchParams } from 'react-router';
import { can } from '../App';
import { Today } from './Today';
import { FrontDesk } from './FrontDesk';

/** One home for everyone who sees patients: the calendar (Today or Week) on the left, what needs you on the right.
 *  A doctor (the owner too) gets the doctor's view; the desk and the junior doctor get the clinic's.
 *  "+ New › Check in" is desk work, so it opens on the desk's view whoever does it. */
export function Dashboard() {
  const { perms } = useOutletContext<any>(); const [sp] = useSearchParams();
  return can(perms, 'encounter.complete') && !sp.get('arrive') ? <Today /> : <FrontDesk />;
}
