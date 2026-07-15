type ReconcileCollapsedMonthsInput = {
  monthKeys: string[];
  currentMonth: string;
  collapsedMonths: Set<string>;
  knownMonths: Set<string>;
};

export type MonthCollapseState = {
  collapsedMonths: Set<string>;
  knownMonths: Set<string>;
};

type ReconcileMonthCollapseStateInput = {
  monthKeys: string[];
  currentMonth: string;
  state: MonthCollapseState;
};

export const reconcileCollapsedMonths = ({
  monthKeys,
  currentMonth,
  collapsedMonths,
  knownMonths
}: ReconcileCollapsedMonthsInput) => {
  const nextCollapsed = new Set(collapsedMonths);
  const nextKnown = new Set(knownMonths);

  for (const monthKey of monthKeys) {
    if (!nextKnown.has(monthKey) && monthKey !== currentMonth) {
      nextCollapsed.add(monthKey);
    }
    nextKnown.add(monthKey);
  }

  return { collapsedMonths: nextCollapsed, knownMonths: nextKnown };
};

export const reconcileMonthCollapseState = ({
  monthKeys,
  currentMonth,
  state
}: ReconcileMonthCollapseStateInput): MonthCollapseState =>
  reconcileCollapsedMonths({
    monthKeys,
    currentMonth,
    collapsedMonths: state.collapsedMonths,
    knownMonths: state.knownMonths
  });
