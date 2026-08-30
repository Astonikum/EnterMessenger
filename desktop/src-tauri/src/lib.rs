#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(desktop)]
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

#[cfg(desktop)]
const MAIN_WINDOW_LABEL: &str = "main";
#[cfg(desktop)]
const TRAY_ID: &str = "main-tray";
#[cfg(desktop)]
const HIDE_ON_CLOSE: bool = true;

#[cfg(desktop)]
#[derive(Default)]
struct DesktopLifecycle {
    quitting: AtomicBool,
}

#[cfg(desktop)]
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn quit_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(lifecycle) = app.try_state::<DesktopLifecycle>() {
        lifecycle.quitting.store(true, Ordering::Release);
    }
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.manage(DesktopLifecycle::default());

    builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            #[cfg(desktop)]
            show_main_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                let show = MenuItemBuilder::with_id("show", "Открыть Enter").build(app)?;
                let quit = MenuItemBuilder::with_id("quit", "Выйти").build(app)?;
                let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
                let icon = app
                    .default_window_icon()
                    .cloned()
                    .ok_or("default window icon is missing")?;

                TrayIconBuilder::with_id(TRAY_ID)
                    .icon(icon)
                    .icon_as_template(true)
                    .menu(&menu)
                    .tooltip("Enter Messenger")
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main_window(app),
                        "quit" => quit_app(app),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == MAIN_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let quitting = window
                        .app_handle()
                        .try_state::<DesktopLifecycle>()
                        .map(|state| state.quitting.load(Ordering::Acquire))
                        .unwrap_or(false);
                    if HIDE_ON_CLOSE && !quitting {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Enter Messenger")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main_window(app),
            #[cfg(desktop)]
            tauri::RunEvent::Exit => {
                let _ = app.remove_tray_by_id(TRAY_ID);
            }
            _ => {}
        });
}

#[cfg(all(test, desktop))]
mod tests {
    use super::{HIDE_ON_CLOSE, MAIN_WINDOW_LABEL, TRAY_ID};

    #[test]
    fn desktop_lifecycle_policy_is_explicit() {
        assert_eq!(MAIN_WINDOW_LABEL, "main");
        assert_eq!(TRAY_ID, "main-tray");
        assert!(HIDE_ON_CLOSE);
    }
}
