import { useEffect, useState } from "react";
import { AppShell } from "./components/AppShell";
import { Card } from "./components/Card";
import { Button } from "./components/Button";
import { AmountField } from "./components/AmountField";
import { SegmentedControl } from "./components/SegmentedControl";
import { Picker, type PickerItem } from "./components/Picker";
import { Stepper } from "./components/Stepper";
import { StatusBanner } from "./components/StatusBanner";
import { ThemeSwitcher } from "./components/ThemeSwitcher";

const COLLECTION_ACCOUNTS: PickerItem[] = [
  { id: "1", name: "Cash Drawer", meta: "Cash" },
  { id: "2", name: "GPay — Vansh", meta: "UPI" },
  { id: "3", name: "Zomato Collections", meta: "Marketplace" },
  { id: "4", name: "Swiggy Collections", meta: "Marketplace" },
];

function HomeScreen() {
  return (
    <>
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-500)" }}>Today's sales</span>
          <span className="tnum" style={{ fontSize: "var(--text-2xl)", fontWeight: 700, color: "var(--ink-900)" }}>₹18,420.00</span>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--success-600)" }}>↑ 12% vs same day last week</span>
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}>
        <Card>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-500)" }}>Cash drawer</span>
          <span className="tnum" style={{ fontSize: "var(--text-lg)", fontWeight: 600 }}>₹6,180.00</span>
        </Card>
        <Card>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-500)" }}>Supplier outstanding</span>
          <span className="tnum" style={{ fontSize: "var(--text-lg)", fontWeight: 600, color: "var(--danger-600)" }}>₹4,250.00</span>
        </Card>
      </div>

      <StatusBanner tone="info">Yesterday isn't closed yet — close it before today's numbers are final.</StatusBanner>
    </>
  );
}

function SalesEntryScreen() {
  const [channel, setChannel] = useState("walk_in");
  const [method, setMethod] = useState("cash");
  const [account, setAccount] = useState<PickerItem | null>(null);
  const [amount, setAmount] = useState("");

  return (
    <Card title="Record a sale">
      <SegmentedControl
        label="Channel"
        value={channel}
        onChange={setChannel}
        options={[
          { value: "walk_in", label: "Walk-in" },
          { value: "zomato", label: "Zomato" },
          { value: "swiggy", label: "Swiggy" },
        ]}
      />
      {channel === "walk_in" && (
        <SegmentedControl
          label="Payment"
          value={method}
          onChange={setMethod}
          options={[
            { value: "cash", label: "Cash" },
            { value: "upi", label: "UPI" },
          ]}
        />
      )}
      {(channel !== "walk_in" || method === "upi") && (
        <Picker
          label="Collection account"
          items={COLLECTION_ACCOUNTS}
          value={account}
          onSelect={setAccount}
        />
      )}
      <AmountField label="Amount" value={amount} onChange={setAmount} required autoFocus />
      <Stepper label="Cups sold (optional)" value={0} unit="cups" onChange={() => {}} />
      <Button fullWidth size="lg" disabled={!amount}>Record sale</Button>
    </Card>
  );
}

function PlaceholderScreen({ name }: { name: string }) {
  return (
    <Card>
      <p style={{ color: "var(--ink-500)", fontSize: "var(--text-sm)" }}>
        {name} entry lands in this same phase — built on the same components shown here.
      </p>
    </Card>
  );
}

export default function App() {
  const [nav, setNav] = useState("sales");
  const [theme, setTheme] = useState("vadapav");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const titles: Record<string, string> = {
    home: "Cravory", sales: "Sales", purchases: "Purchases", expenses: "Expenses", more: "More",
  };

  return (
    <AppShell
      active={nav}
      onNavigate={setNav}
      title={titles[nav]}
      primaryAction={<ThemeSwitcher value={theme} onChange={setTheme} />}
    >
      {nav === "home" && <HomeScreen />}
      {nav === "sales" && <SalesEntryScreen />}
      {nav === "purchases" && <PlaceholderScreen name="Purchase" />}
      {nav === "expenses" && <PlaceholderScreen name="Expense" />}
      {nav === "more" && <PlaceholderScreen name="More" />}
    </AppShell>
  );
}
