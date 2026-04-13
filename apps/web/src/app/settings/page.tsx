import { PmSettingsPanel } from "../../components/settings/pm-settings-panel";

export default function SettingsPage() {
  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Settings</h1>
        <p className="page-subtitle">Manage gateway connection, auth profiles, and model policies</p>
      </header>
      <PmSettingsPanel />
    </div>
  );
}
