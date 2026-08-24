# Phase 1 — Progressive Transaction History

This phase improves the Sales, Purchases, and Expenses entry screens without changing
financial calculations, ledger behavior, transaction schemas, or existing accounting logic.

The objective is to make the recent-record area fast and focused while preserving complete
historical traceability.

## Scope

The following three entry screens are included:

- Sales
- Purchases
- Expenses

Each screen currently exposes recent transaction records. In this phase, the initial record
list must be limited to the five most recent records for the current screen/context.

## Required behavior

### Initial load

When the user opens Sales, Purchases, or Expenses:

- Fetch and render only the five most recent matching transactions.
- Sort by the transaction's effective transaction date/time, newest first.
- Do not preload the entire historical transaction set into the browser.
- Preserve the existing filters/date-range/context already supported by the screen.
- The five-record limit applies to the rendered recent-record list, not to database-wide search.

### Load more

If additional records exist, display a clear action below the list:

`Load 20 more`

When selected:

- Keep the records already displayed.
- Fetch the next 20 records in the same sort order and context.
- Append them to the existing list.
- Do not replace the existing records.
- Do not duplicate records.
- Continue using an appropriate database query rather than downloading the entire table.

The sequence should therefore be:

```text
Initial open
    ↓
5 records
    ↓
Load 20 more
    ↓
25 records
    ↓
Load 20 more
    ↓
45 records
    ↓
...
```

### End of history

When the database has no more matching records:

- Remove/disable the Load 20 more action.
- Display a small, unobtrusive end-of-history message where appropriate.
- Do not repeatedly issue queries after the end has been established.

Example:

`You're all caught up.`

The UI should not imply that more records exist when the current filter/context has reached
the oldest available transaction.

## Search and filtering requirements

Progressive loading must not restrict historical search.

If the screen supports search/filtering, those operations must query the full applicable
dataset rather than searching only the five or twenty-five records currently rendered.

Examples:

- Searching for an old invoice/transaction number must find it even when it is not loaded in the initial five.
- Searching by supplier must search all matching purchase records.
- Searching by expense category/item must search all matching expense records.
- Date-range filters must be applied server-side where practical.
- Changing a filter resets the progressive list to the first five matching records.
- Loading more after a filter continues from that filtered result set.

## Pagination strategy

Do not implement this as client-side slicing of a complete database response.

The preferred implementation is database pagination using a stable cursor/keyset strategy,
with offset pagination used only if the existing data-access layer makes that substantially
safer and simpler.

The pagination query must have a deterministic ordering. Where multiple records have the
same transaction date/time, a unique secondary key (such as transaction UUID) must be used
to prevent skipped or duplicated rows between pages.

Conceptually:

```text
ORDER BY transaction_date DESC, transaction_id DESC
```

with a cursor derived from the last loaded record.

The exact field names must follow the existing schema rather than introducing duplicate
transaction-date concepts.

## Refresh behavior

After a new Sales, Purchase, or Expense transaction is successfully committed:

- The recent-record list should refresh appropriately.
- The newly created transaction should appear at the top when it matches the active context/filter.
- The current loaded-record count should not cause the application to fetch the entire history.
- If the user is viewing an older filtered context where the new transaction does not match,
  the existing context should remain stable.

After a transaction is reversed or otherwise changes visibility/status:

- The list must remain consistent with the existing transaction/reversal rules.
- No duplicate transaction row should appear.
- Pagination must continue correctly.

## Loading states

The UI must distinguish between:

- Initial loading
- Loading more
- No records
- No additional records
- Search/filter returned no records
- Database/network error

The Load 20 more action should be disabled while its request is in progress so repeated
clicks cannot create concurrent duplicate fetches.

A lightweight loading indicator is preferred over a large blocking spinner.

## Error handling

If loading the next 20 records fails:

- Preserve the records already visible.
- Show a concise error message.
- Re-enable the Load 20 more action.
- Allow the user to retry.

A failed pagination request must never clear the existing record list.

## Reusable implementation

The behavior should be implemented as a reusable transaction-list/pagination pattern rather
than three unrelated implementations.

The reusable pattern should accept at minimum:

- transaction type/source
- initial limit (`5`)
- incremental limit (`20`)
- active filters/search context
- ordering/cursor information
- row renderer
- empty state
- end-of-history state

Sales, Purchases, and Expenses should use the same pagination mechanism while retaining their
existing row-specific UI and actions.

## Database/API considerations

This phase should avoid schema changes unless inspection of the current data-access layer proves
one is necessary.

Prefer the existing transaction/detail tables and existing Supabase access patterns.

No financial RPC behavior should be modified merely to implement pagination.

No new financial ledger entries are created by this phase.

## UX requirements

The list should remain visually compact and consistent with the existing Tasty Vadapav design.

The user should understand:

1. These are the five latest records.
2. More historical records exist if the Load 20 more action is shown.
3. Selecting Load 20 more adds twenty more records.
4. They can continue until the oldest matching transaction.

Avoid infinite scrolling because explicit pagination is preferable for financial records and
makes the user's position in historical data clearer.

The Load 20 more control should be placed immediately after the current record list and should
not compete visually with primary transaction-entry actions.

## Acceptance criteria

### Sales

- Opening Sales renders at most five recent sales.
- Load 20 more appends twenty additional sales when available.
- Repeated loading continues until the oldest matching sale.
- No duplicate/skipped rows occur across page boundaries.
- Search can find a sale older than the currently loaded five records.
- Filters reset pagination correctly.

### Purchases

- Opening Purchases renders at most five recent purchases.
- Load 20 more appends twenty additional purchases when available.
- Repeated loading continues until the oldest matching purchase.
- No duplicate/skipped rows occur across page boundaries.
- Search/filtering operates against the complete applicable purchase history.

### Expenses

- Opening Expenses renders at most five recent expenses.
- Load 20 more appends twenty additional expenses when available.
- Repeated loading continues until the oldest matching expense.
- No duplicate/skipped rows occur across page boundaries.
- Search/filtering operates against the complete applicable expense history.

### General

- Existing financial calculations remain unchanged.
- Existing transaction creation workflows remain unchanged.
- Existing permissions/RLS behavior remains unchanged.
- No complete historical dataset is loaded merely to render the recent-record list.
- npm/local validation passes after implementation.
- The application remains usable on desktop and mobile.

## Local development/testing

The project now includes a dependency-light Node.js local server and validation commands.

Run:

```powershell
npm run check
npm run dev
```

Then open:

```text
http://127.0.0.1:5173
```

Phase 1 must be tested locally before committing/pushing to GitHub.

## Implementation discipline

Do not combine unrelated feature work into this phase.

This phase is intentionally limited to progressive transaction history and its reusable
pagination/search behavior.

Future phases will build on this pattern for other lists where appropriate.

## Implementation status

Phase 1 is implemented in the current source tree.

### Implemented

- Sales, Purchases, and Expenses now load an initial five records.
- Additional history is loaded in explicit batches of twenty.
- Pagination uses a reusable keyset/cursor helper ordered by `txn_date`, `created_at`, and `id`.
- Existing rows remain visible while additional rows are appended.
- Duplicate/skipped page boundaries are guarded by the composite cursor.
- The Load 20 more control is disabled/replaced by a loading state during requests.
- Pagination failures preserve the current list and expose Retry.
- The end-of-history state is shown once the final partial page is reached.
- No database schema or financial RPC changes were required.
- The existing transaction-entry workflows remain unchanged.

### Local validation

`npm run check` passes after the implementation.
