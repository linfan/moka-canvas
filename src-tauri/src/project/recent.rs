use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub last_opened: String,
}

pub struct RecentRegistry {
    path: PathBuf,
    entries: Vec<RecentProject>,
}

const MAX_RECENT: usize = 24;

impl RecentRegistry {
    pub fn load(path: &Path) -> Self {
        let entries = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<RecentProject>>(&raw).ok())
            .unwrap_or_default();
        Self {
            path: path.to_path_buf(),
            entries,
        }
    }

    pub fn entries(&self) -> &[RecentProject] {
        &self.entries
    }

    pub fn upsert(&mut self, project: RecentProject) {
        self.entries
            .retain(|entry| entry.id != project.id && entry.path != project.path);
        self.entries.insert(0, project);
        self.entries.truncate(MAX_RECENT);
        self.persist();
    }

    pub fn remove(&mut self, id: &str) {
        self.entries.retain(|entry| entry.id != id);
        self.persist();
    }

    fn persist(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(raw) = serde_json::to_string_pretty(&self.entries) {
            if std::fs::write(&tmp, raw).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }
}
