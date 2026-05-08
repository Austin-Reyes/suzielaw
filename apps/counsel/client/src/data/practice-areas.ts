export interface PracticeArea {
  id: string;
  label: string;
}

export const PRACTICE_AREAS: PracticeArea[] = [
  { id: 'general', label: 'General' },
  { id: 'antitrust', label: 'Antitrust' },
  { id: 'arbitration', label: 'Arbitration' },
  { id: 'business-of-law', label: 'Business of Law' },
  { id: 'capital-markets', label: 'Capital Markets' },
  { id: 'employment', label: 'Employment' },
  { id: 'intellectual-property', label: 'Intellectual Property' },
  { id: 'litigation', label: 'Litigation' },
  { id: 'mergers-acquisitions', label: 'Mergers & Acquisitions' },
  { id: 'privacy-data', label: 'Privacy & Data' },
  { id: 'real-estate', label: 'Real Estate' },
  { id: 'tax', label: 'Tax' },
  { id: 'transactional', label: 'Transactional' },
];

export function practiceAreaLabel(id: string): string {
  return PRACTICE_AREAS.find((p) => p.id === id)?.label ?? id;
}
