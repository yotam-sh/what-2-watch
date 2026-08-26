"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/Button";

export function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  return (
    <Button onClick={handleLogout} disabled={loading} variant="ghost" size="sm">
      <LogOut className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      {loading ? "Logging out…" : "Log out"}
    </Button>
  );
}
