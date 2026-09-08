use importer_domain::settings::UiLanguage;
use tauri::Manager;

use crate::settings::SettingsService;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeText {
    TrayShow,
    TrayRefresh,
    TrayQuit,
    TrayTooltip,
    ImportStillRunning,
    CloseRunningImport,
    QuitRunningImport,
    PlanReady,
    CameraConfirmation,
    CameraConfirmationBody,
    WorkflowFailed,
    WorkflowFailedBody,
    ImportStarted,
    ImportStartedBody,
    ImportPaused,
    ImportPausedBody,
    CardDisconnected,
    CardDisconnectedBody,
    ImportFailed,
    ImportFailedBody,
    ImportCompleted,
    ImportRollingBack,
    ImportRollingBackBody,
    RollbackNeedsAttention,
    RollbackNeedsAttentionBody,
    ImportCancelled,
    ImportCancelledBody,
    CardRemembered,
    NewCardDetected,
    NewCardNotification,
    NewCardNotificationBody,
    CardDisconnectedWorkflow,
    MediaDisconnected,
    KnownCardDetected,
    CardDetected,
    AutoScanStarted,
    AutoScanStartFailed,
    AutoScanCompleted,
    ScanCancelled,
    AutoScanIncomplete,
    ScanProblem,
    ScanProblemBody,
}

#[cfg(test)]
const ALL_NATIVE_TEXTS: [NativeText; 42] = [
    NativeText::TrayShow,
    NativeText::TrayRefresh,
    NativeText::TrayQuit,
    NativeText::TrayTooltip,
    NativeText::ImportStillRunning,
    NativeText::CloseRunningImport,
    NativeText::QuitRunningImport,
    NativeText::PlanReady,
    NativeText::CameraConfirmation,
    NativeText::CameraConfirmationBody,
    NativeText::WorkflowFailed,
    NativeText::WorkflowFailedBody,
    NativeText::ImportStarted,
    NativeText::ImportStartedBody,
    NativeText::ImportPaused,
    NativeText::ImportPausedBody,
    NativeText::CardDisconnected,
    NativeText::CardDisconnectedBody,
    NativeText::ImportFailed,
    NativeText::ImportFailedBody,
    NativeText::ImportCompleted,
    NativeText::ImportRollingBack,
    NativeText::ImportRollingBackBody,
    NativeText::RollbackNeedsAttention,
    NativeText::RollbackNeedsAttentionBody,
    NativeText::ImportCancelled,
    NativeText::ImportCancelledBody,
    NativeText::CardRemembered,
    NativeText::NewCardDetected,
    NativeText::NewCardNotification,
    NativeText::NewCardNotificationBody,
    NativeText::CardDisconnectedWorkflow,
    NativeText::MediaDisconnected,
    NativeText::KnownCardDetected,
    NativeText::CardDetected,
    NativeText::AutoScanStarted,
    NativeText::AutoScanStartFailed,
    NativeText::AutoScanCompleted,
    NativeText::ScanCancelled,
    NativeText::AutoScanIncomplete,
    NativeText::ScanProblem,
    NativeText::ScanProblemBody,
];

pub(crate) fn app_language(app: &tauri::AppHandle) -> UiLanguage {
    app.state::<SettingsService>()
        .current_settings()
        .map_or(UiLanguage::En, |settings| settings.local.ui_language)
}

pub(crate) fn text(language: UiLanguage, key: NativeText) -> &'static str {
    match language {
        UiLanguage::En => english(key),
        UiLanguage::Pl => polish(key),
    }
}

pub(crate) fn app_text(app: &tauri::AppHandle, key: NativeText) -> &'static str {
    text(app_language(app), key)
}

pub(crate) fn plan_file_count(language: UiLanguage, count: usize) -> String {
    match language {
        UiLanguage::En => format!("The plan contains {count} files and is waiting for approval."),
        UiLanguage::Pl => format!("Plan obejmuje {count} plików i czeka na zatwierdzenie."),
    }
}

pub(crate) fn imported_file_count(language: UiLanguage, count: usize) -> String {
    match language {
        UiLanguage::En => format!("Imported {count} files."),
        UiLanguage::Pl => format!("Zaimportowano {count} plików."),
    }
}

pub(crate) fn card_ready(language: UiLanguage, profile: &str) -> String {
    match language {
        UiLanguage::En => format!("{profile} is ready. Open the application to start scanning."),
        UiLanguage::Pl => format!("{profile} jest gotowy. Otwórz aplikację, aby rozpocząć skan."),
    }
}

pub(crate) fn scan_result(language: UiLanguage, profile: &str, count: usize) -> String {
    match language {
        UiLanguage::En => format!("{profile}: found {count} items"),
        UiLanguage::Pl => format!("{profile}: znaleziono {count} pozycji"),
    }
}

fn english(key: NativeText) -> &'static str {
    match key {
        NativeText::TrayShow => "Show Photo Importer",
        NativeText::TrayRefresh => "Check media now",
        NativeText::TrayQuit => "Quit",
        NativeText::TrayTooltip => "Photo Importer — media monitor is running",
        NativeText::ImportStillRunning => "Import is still running",
        NativeText::CloseRunningImport => {
            "Pause or cancel the import before closing the application."
        }
        NativeText::QuitRunningImport => {
            "Pause or cancel the import before quitting the application."
        }
        NativeText::PlanReady => "Import plan is ready",
        NativeText::CameraConfirmation => "Camera confirmation required",
        NativeText::CameraConfirmationBody => {
            "A new EXIF profile was detected on the card. Open the application to approve it."
        }
        NativeText::WorkflowFailed => "Could not prepare the import plan",
        NativeText::WorkflowFailedBody => "Open the application to review the error and try again.",
        NativeText::ImportStarted => "Import started",
        NativeText::ImportStartedBody => "Import is running in the background.",
        NativeText::ImportPaused => "Import paused",
        NativeText::ImportPausedBody => "The session can be resumed safely.",
        NativeText::CardDisconnected => "Card disconnected",
        NativeText::CardDisconnectedBody => "Connect the correct card and select Resume.",
        NativeText::ImportFailed => "Import error",
        NativeText::ImportFailedBody => {
            "The import was not completed. Open the application for details."
        }
        NativeText::ImportCompleted => "Import completed",
        NativeText::ImportRollingBack => "Rolling back import",
        NativeText::ImportRollingBackBody => {
            "Only unchanged files from this session are being removed."
        }
        NativeText::RollbackNeedsAttention => "Rollback needs attention",
        NativeText::RollbackNeedsAttentionBody => {
            "The rollback can be retried from the application."
        }
        NativeText::ImportCancelled => "Import cancelled",
        NativeText::ImportCancelledBody => "Rollback completed or finished files were kept.",
        NativeText::CardRemembered => "Card remembered",
        NativeText::NewCardDetected => "New card detected",
        NativeText::NewCardNotification => "New memory card detected",
        NativeText::NewCardNotificationBody => {
            "Open the application to scan the card and approve the EXIF camera."
        }
        NativeText::CardDisconnectedWorkflow => {
            "The card was disconnected. Reconnect it to start the import."
        }
        NativeText::MediaDisconnected => "Media disconnected",
        NativeText::KnownCardDetected => "Known card detected",
        NativeText::CardDetected => "Memory card detected",
        NativeText::AutoScanStarted => "Automatic scan started",
        NativeText::AutoScanStartFailed => "Could not start the scan",
        NativeText::AutoScanCompleted => "Automatic scan completed",
        NativeText::ScanCancelled => "The scan was cancelled.",
        NativeText::AutoScanIncomplete => "Automatic scan was not completed",
        NativeText::ScanProblem => "Problem scanning the card",
        NativeText::ScanProblemBody => "Open the application to review the scan error.",
    }
}

fn polish(key: NativeText) -> &'static str {
    match key {
        NativeText::TrayShow => "Pokaż Photo Importer",
        NativeText::TrayRefresh => "Sprawdź nośniki teraz",
        NativeText::TrayQuit => "Zakończ",
        NativeText::TrayTooltip => "Photo Importer — monitor nośników działa",
        NativeText::ImportStillRunning => "Import nadal trwa",
        NativeText::CloseRunningImport => {
            "Najpierw wstrzymaj lub anuluj import, a następnie zamknij aplikację."
        }
        NativeText::QuitRunningImport => {
            "Najpierw wstrzymaj lub anuluj import, a następnie zakończ aplikację."
        }
        NativeText::PlanReady => "Plan importu jest gotowy",
        NativeText::CameraConfirmation => "Wymagane potwierdzenie aparatu",
        NativeText::CameraConfirmationBody => {
            "Na karcie wykryto nowy profil EXIF. Otwórz aplikację, aby go zatwierdzić."
        }
        NativeText::WorkflowFailed => "Nie udało się przygotować planu",
        NativeText::WorkflowFailedBody => {
            "Otwórz aplikację, aby sprawdzić błąd i spróbować ponownie."
        }
        NativeText::ImportStarted => "Import rozpoczęty",
        NativeText::ImportStartedBody => "Import działa w tle.",
        NativeText::ImportPaused => "Import wstrzymany",
        NativeText::ImportPausedBody => "Sesję można bezpiecznie wznowić.",
        NativeText::CardDisconnected => "Karta została odłączona",
        NativeText::CardDisconnectedBody => "Podłącz właściwą kartę i wybierz Wznów.",
        NativeText::ImportFailed => "Błąd importu",
        NativeText::ImportFailedBody => {
            "Import nie został ukończony. Otwórz aplikację, aby zobaczyć szczegóły."
        }
        NativeText::ImportCompleted => "Import zakończony",
        NativeText::ImportRollingBack => "Wycofywanie importu",
        NativeText::ImportRollingBackBody => "Usuwane są wyłącznie niezmienione pliki tej sesji.",
        NativeText::RollbackNeedsAttention => "Wycofanie wymaga uwagi",
        NativeText::RollbackNeedsAttentionBody => "Wycofanie można ponowić w aplikacji.",
        NativeText::ImportCancelled => "Import anulowany",
        NativeText::ImportCancelledBody => "Zakończono wycofanie lub zachowano ukończone pliki.",
        NativeText::CardRemembered => "Karta została zapamiętana",
        NativeText::NewCardDetected => "Wykryto nową kartę",
        NativeText::NewCardNotification => "Wykryto nową kartę pamięci",
        NativeText::NewCardNotificationBody => {
            "Otwórz aplikację, aby przeskanować kartę i zatwierdzić aparat z EXIF."
        }
        NativeText::CardDisconnectedWorkflow => {
            "Karta została odłączona. Podłącz ją ponownie, aby rozpocząć import."
        }
        NativeText::MediaDisconnected => "Odłączono nośnik",
        NativeText::KnownCardDetected => "Wykryto znaną kartę",
        NativeText::CardDetected => "Wykryto kartę pamięci",
        NativeText::AutoScanStarted => "Automatyczny skan rozpoczęty",
        NativeText::AutoScanStartFailed => "Nie udało się uruchomić skanu",
        NativeText::AutoScanCompleted => "Automatyczny skan zakończony",
        NativeText::ScanCancelled => "Skan został anulowany.",
        NativeText::AutoScanIncomplete => "Automatyczny skan nie został ukończony",
        NativeText::ScanProblem => "Problem podczas skanowania karty",
        NativeText::ScanProblemBody => "Otwórz aplikację, aby sprawdzić błąd skanowania.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_catalog_contains_both_languages() {
        for key in ALL_NATIVE_TEXTS {
            assert!(!text(UiLanguage::En, key).trim().is_empty());
            assert!(!text(UiLanguage::Pl, key).trim().is_empty());
            assert_ne!(text(UiLanguage::En, key), text(UiLanguage::Pl, key));
        }

        assert_eq!(text(UiLanguage::En, NativeText::TrayQuit), "Quit");
        assert_eq!(text(UiLanguage::Pl, NativeText::TrayQuit), "Zakończ");
        assert_eq!(
            plan_file_count(UiLanguage::En, 3),
            "The plan contains 3 files and is waiting for approval."
        );
        assert_eq!(
            plan_file_count(UiLanguage::Pl, 3),
            "Plan obejmuje 3 plików i czeka na zatwierdzenie."
        );
    }
}
