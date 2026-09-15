import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  loadSettings,
  saveSettings,
  type AppSettings,
  type SettingsResponse,
} from "./settings";

export type SettingsUpdater = (settings: AppSettings) => AppSettings;

interface SettingsStoreValue {
  settings: AppSettings | null;
  response: SettingsResponse | null;
  loadError: unknown;
  reload: () => Promise<SettingsResponse>;
  updateSettings: (updater: SettingsUpdater) => Promise<SettingsResponse>;
  replaceSettings: (
    operation: () => Promise<SettingsResponse>,
  ) => Promise<SettingsResponse>;
}

const SettingsStoreContext = createContext<SettingsStoreValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [response, setResponse] = useState<SettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());

  const acceptResponse = useCallback((response: SettingsResponse) => {
    settingsRef.current = response.settings;
    setSettings(response.settings);
    setResponse(response);
    setLoadError(null);
  }, []);

  const reload = useCallback(async () => {
    try {
      const response = await loadSettings();
      acceptResponse(response);
      return response;
    } catch (error) {
      setLoadError(error);
      throw error;
    }
  }, [acceptResponse]);

  const updateSettings = useCallback(
    (updater: SettingsUpdater) => {
      const operation = saveQueue.current
        .catch(() => undefined)
        .then(async () => {
          const current = settingsRef.current;
          if (!current) throw new Error("Settings are not loaded");
          const response = await saveSettings(updater(current));
          acceptResponse(response);
          return response;
        });
      saveQueue.current = operation;
      return operation;
    },
    [acceptResponse],
  );

  const replaceSettings = useCallback(
    (operation: () => Promise<SettingsResponse>) => {
      const queued = saveQueue.current
        .catch(() => undefined)
        .then(async () => {
          const response = await operation();
          acceptResponse(response);
          return response;
        });
      saveQueue.current = queued;
      return queued;
    },
    [acceptResponse],
  );

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  return (
    <SettingsStoreContext.Provider
      value={{
        settings,
        response,
        loadError,
        reload,
        updateSettings,
        replaceSettings,
      }}
    >
      {children}
    </SettingsStoreContext.Provider>
  );
}

export function useSettingsStore() {
  return useContext(SettingsStoreContext);
}
