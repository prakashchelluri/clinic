/** Short lists every clinic starts with and may change in Settings. */

/** The tests a doctor picks from on the pad (Settings › Lab tests). */
export const DEFAULT_LAB_TESTS = ['CBC', 'FBS / PPBS', 'HbA1c', 'LFT', 'RFT', 'Lipid profile', 'TSH', 'Vitamin D', 'Vitamin B12', 'Serum ferritin', 'KOH mount', 'Skin biopsy', 'Patch test', 'VDRL', 'HIV', 'HBsAg', 'ANA', 'Urine routine', 'Culture & sensitivity', 'Woods lamp'];

/** What an expense is for (Settings › Billing & payments). */
export const DEFAULT_EXPENSE_CATEGORIES = ['Staff salary', 'Rent', 'Electricity and water', 'Medicines and supplies', 'Consumables', 'Equipment and repairs', 'Lab and outsourced work', 'Marketing', 'Travel and fuel', 'Tea and snacks', 'Cleaning', 'Taxes and fees', 'Other'];

const listOr = (v: unknown, dflt: string[]) => (Array.isArray(v) && v.length ? (v as string[]) : dflt);
export const labTestsOf = (settings: any) => listOr(settings?.labTests, DEFAULT_LAB_TESTS);
export const expenseCategoriesOf = (settings: any) => listOr(settings?.expenseCategories, DEFAULT_EXPENSE_CATEGORIES);
