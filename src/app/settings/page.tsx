import { redirect } from "next/navigation";
import { LogoutButton } from "@/app/LogoutButton";
import { SettingsScreen } from "@/components/SettingsScreen";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";

export default async function SettingsPage() {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect("/");
    throw err;
  }

  return (
    <div className="relative">
      <div className="absolute right-4 top-6">
        <LogoutButton />
      </div>
      <SettingsScreen username={user.username} />
    </div>
  );
}
