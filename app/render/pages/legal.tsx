import type { ReactElement } from 'react';
import LegalCenter from '@/components/legal/LegalCenter';

export default function LegalPage() {
  return <LegalCenter />;
}

// Standalone page (no app sidebar/header) so it can be opened directly from the
// login modal before a user is signed in. Individual documents are reached via
// hash anchors, e.g. /legal#privacy.
LegalPage.getLayout = (page: ReactElement) => page;
