package com.illustratedstory.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * Durable task data deliberately excludes provider credentials.
 *
 * <p>All mutating operations serialize on a single class-level monitor so the
 * plugin, the foreground service and recovery code can never observe or write
 * a stale task record even though each creates its own instance. Terminal
 * transitions are additionally guarded ({@link #completeIfRunning},
 * {@link #failUnlessCancelled}, {@link #cancelIfActive}) so a cancelled task
 * is never silently re-completed or re-failed by a late worker.</p>
 */
final class BackgroundTaskStore {
    static final String PREPARED = "prepared";
    static final String RUNNING = "running";
    static final String COMPLETED = "completed";
    static final String FAILED = "failed";
    static final String CANCELLED = "cancelled";
    static final String UNKNOWN = "unknown";

    /** Cross-instance lock: plugin, service and recovery each build their own store. */
    private static final Object MUTEX = new Object();

    private final File directory;

    BackgroundTaskStore(Context context) {
        this(new File(context.getFilesDir(), "background-generation-tasks"));
    }

    BackgroundTaskStore(File directory) { this.directory = directory; }

    /** Applies an extra field mutation before a guarded RUNNING→COMPLETED transition. */
    interface Mutator { void apply(JSONObject task) throws Exception; }

    JSONObject create(JSONObject task) throws Exception {
        synchronized (MUTEX) {
            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建后台任务目录");
            String id = "bg_" + UUID.randomUUID().toString();
            task.put("id", id);
            task.put("state", PREPARED);
            task.put("createdAt", System.currentTimeMillis());
            write(id, task);
            return task;
        }
    }

    JSONObject read(String id) throws Exception {
        synchronized (MUTEX) {
            File file = fileFor(id);
            restoreTaskFileIfNeeded(id);
            try (FileInputStream input = new FileInputStream(file)) {
                byte[] bytes = new byte[(int) file.length()];
                int offset = 0;
                while (offset < bytes.length) {
                    int read = input.read(bytes, offset, bytes.length - offset);
                    if (read < 0) break;
                    offset += read;
                }
                return new JSONObject(new String(bytes, 0, offset, StandardCharsets.UTF_8));
            }
        }
    }

    void write(String id, JSONObject task) throws Exception {
        synchronized (MUTEX) {
            File target = fileFor(id);
            File temporary = new File(target.getParentFile(), target.getName() + ".tmp");
            File backup = backupFile(id);
            try (FileOutputStream output = new FileOutputStream(temporary, false)) {
                output.write(task.toString().getBytes(StandardCharsets.UTF_8));
                output.flush();
                output.getFD().sync();
            }
            restoreTaskFileIfNeeded(id);
            if (backup.exists() && !backup.delete()) throw new IllegalStateException("无法清理旧后台任务备份");
            if (target.exists() && !target.renameTo(backup)) throw new IllegalStateException("无法备份后台任务");
            if (!temporary.renameTo(target)) {
                if (backup.exists()) backup.renameTo(target);
                throw new IllegalStateException("无法保存后台任务");
            }
            if (backup.exists() && !backup.delete()) {
                // New target is already durable; leave stale backup for a later read cleanup.
            }
        }
    }

    /** Low-level state write used only by the plugin/service guarded transitions. */
    JSONObject transition(String id, String state, String error) throws Exception {
        synchronized (MUTEX) {
            JSONObject task = read(id);
            task.put("state", state);
            task.put("updatedAt", System.currentTimeMillis());
            if (error == null) task.remove("error"); else task.put("error", error);
            write(id, task);
            return task;
        }
    }

    /** Starts a PREPARED task; returns false when it was cancelled or removed before this worker ran. */
    boolean startRunning(String id) throws Exception {
        synchronized (MUTEX) {
            JSONObject task;
            try { task = read(id); } catch (Exception ignored) { return false; }
            if (!PREPARED.equals(task.optString("state"))) return false;
            task.put("state", RUNNING);
            task.put("updatedAt", System.currentTimeMillis());
            write(id, task);
            return true;
        }
    }

    /** Marks a PREPARED/RUNNING task cancelled; returns false when it is already terminal. */
    boolean cancelIfActive(String id, String error) throws Exception {
        synchronized (MUTEX) {
            JSONObject task;
            try { task = read(id); } catch (Exception ignored) { return false; }
            String state = task.optString("state");
            if (!PREPARED.equals(state) && !RUNNING.equals(state)) return false;
            task.put("state", CANCELLED);
            task.put("error", error);
            task.put("updatedAt", System.currentTimeMillis());
            write(id, task);
            return true;
        }
    }

    /**
     * Atomically transitions a RUNNING task to COMPLETED with the given extra
     * fields; returns false when the task is no longer running (cancelled or
     * removed) so the caller can discard any late side artifacts.
     */
    boolean completeIfRunning(String id, Mutator mutator) throws Exception {
        synchronized (MUTEX) {
            JSONObject task;
            try { task = read(id); } catch (Exception ignored) { return false; }
            if (!RUNNING.equals(task.optString("state"))) return false;
            mutator.apply(task);
            task.put("state", COMPLETED);
            task.remove("error");
            task.put("updatedAt", System.currentTimeMillis());
            write(id, task);
            return true;
        }
    }

    /** Marks a task failed unless it was already cancelled or removed; returns false in those cases. */
    boolean failUnlessCancelled(String id, String error) throws Exception {
        synchronized (MUTEX) {
            JSONObject task;
            try { task = read(id); } catch (Exception ignored) { return false; }
            if (CANCELLED.equals(task.optString("state"))) return false;
            task.put("state", FAILED);
            task.put("error", error);
            task.put("updatedAt", System.currentTimeMillis());
            write(id, task);
            return true;
        }
    }

    /** A process restart can only make an already-running request uncertain. */
    JSONArray list() throws Exception {
        synchronized (MUTEX) {
            JSONArray tasks = new JSONArray();
            File[] files = directory.listFiles((dir, name) -> name.endsWith(".json"));
            if (files == null) return tasks;
            for (File file : files) {
                String id = file.getName().substring(0, file.getName().length() - 5);
                JSONObject task;
                try { task = read(id); } catch (Exception ignored) { continue; }
                String state = task.optString("state");
                tasks.put(task);
            }
            return tasks;
        }
    }

    void markInFlightUnknown() throws Exception {
        synchronized (MUTEX) {
            File[] files = directory.listFiles((dir, name) -> name.endsWith(".json"));
            if (files == null) return;
            for (File file : files) {
                String id = file.getName().substring(0, file.getName().length() - 5);
                JSONObject task;
                try { task = read(id); } catch (Exception ignored) { continue; }
                String state = task.optString("state");
                if (PREPARED.equals(state) || RUNNING.equals(state)) {
                    if ("text".equals(task.optString("kind")) && hasCompleteResponse(id)) {
                        task.put("responsePath", responseFile(id).getName());
                        task.put("state", COMPLETED);
                        task.remove("error");
                        task.put("updatedAt", System.currentTimeMillis());
                        write(id, task);
                        continue;
                    }
                    File partial = responseTemporaryFile(id);
                    if (partial.exists()) partial.delete();
                    if (PREPARED.equals(state)) {
                        task.put("state", FAILED);
                        task.put("error", "任务尚未发出，应用已退出");
                    } else {
                        task.put("state", UNKNOWN);
                        task.put("error", "任务在应用退出时状态不明，未自动重试以避免重复计费");
                    }
                    task.put("updatedAt", System.currentTimeMillis());
                    write(id, task);
                }
            }
        }
    }

    void delete(String id) {
        synchronized (MUTEX) {
            File file = fileFor(id);
            if (file.exists()) file.delete();
            File backup = backupFile(id);
            if (backup.exists()) backup.delete();
            File taskTemporary = new File(file.getParentFile(), file.getName() + ".tmp");
            if (taskTemporary.exists()) taskTemporary.delete();
            File response = new File(file.getParentFile(), id.replaceAll("[^a-zA-Z0-9_-]", "_") + ".response.json");
            if (response.exists()) response.delete();
            File temporary = responseTemporaryFile(id);
            if (temporary.exists()) temporary.delete();
        }
    }

    private File fileFor(String id) { return new File(directory, id.replaceAll("[^a-zA-Z0-9_-]", "_") + ".json"); }
    File backupFile(String id) { return new File(directory, id.replaceAll("[^a-zA-Z0-9_-]", "_") + ".json.backup"); }
    File responseFile(String id) { return new File(directory, id.replaceAll("[^a-zA-Z0-9_-]", "_") + ".response.json"); }
    File responseTemporaryFile(String id) { return new File(directory, id.replaceAll("[^a-zA-Z0-9_-]", "_") + ".response.tmp"); }
    private boolean hasCompleteResponse(String id) {
        File response = responseFile(id);
        if (!response.isFile() || response.length() == 0) return false;
        try {
            JSONObject root = new JSONObject(readFile(response));
            return root.has("choices") && root.optJSONArray("choices") != null;
        } catch (Exception ignored) { return false; }
    }
    private static String readFile(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()]; int offset = 0, read;
            while (offset < bytes.length && (read = input.read(bytes, offset, bytes.length - offset)) >= 0) offset += read;
            return new String(bytes, 0, offset, StandardCharsets.UTF_8);
        }
    }
    private void restoreTaskFileIfNeeded(String id) throws Exception {
        File target = fileFor(id);
        File backup = backupFile(id);
        if (!target.exists() && backup.exists()) {
            if (!backup.renameTo(target)) throw new IllegalStateException("无法恢复后台任务备份");
        } else if (target.exists() && backup.exists()) {
            backup.delete();
        }
    }
}
