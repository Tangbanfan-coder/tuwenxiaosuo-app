package com.illustratedstory.app;

import android.net.Uri;
import android.util.Base64;
import android.util.Base64InputStream;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

@CapacitorPlugin(name = "ImageAssetStore")
public class ImageAssetStorePlugin extends Plugin {
    private static final int CONNECT_TIMEOUT_MS = 30_000;
    private static final int READ_TIMEOUT_MS = 180_000;
    private static final int COPY_BUFFER_BYTES = 64 * 1024;
    private static final int MAX_REDIRECTS = 5;
    private static final int MAX_GENERATION_RESPONSE_BYTES = 32 * 1024 * 1024;
    private static final String[] IMAGE_EXTENSIONS = {"png", "jpg", "webp", "gif", "heic", "avif"};

    @PluginMethod
    public void download(PluginCall call) {
        String sourceUrl = call.getString("url");
        String projectId = safeSegment(call.getString("projectId", ""));
        String assetId = safeSegment(call.getString("assetId", ""));
        String bearerToken = call.getString("bearerToken");
        if (sourceUrl == null || sourceUrl.isEmpty() || projectId.isEmpty() || assetId.isEmpty()) {
            call.reject("下载参数不完整");
            return;
        }

        getBridge().execute(() -> {
            long startedAt = System.currentTimeMillis();
            HttpURLConnection connection = null;
            File temporary = null;
            try {
                File directory = imageDirectory(projectId);
                ensureDirectory(directory);
                temporary = new File(directory, assetId + ".download.tmp");
                connection = openConnectionFollowingRedirects(new URL(sourceUrl), bearerToken);
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) throw new DownloadException("图片下载返回 HTTP " + status, status);
                long responseAt = System.currentTimeMillis();
                long bytes = copyResponse(connection.getInputStream(), temporary);
                long writeAt = System.currentTimeMillis();
                StoredImage stored = finalizeImage(directory, temporary, assetId, bytes, responseAt - startedAt, writeAt - responseAt, startedAt);
                call.resolve(stored.toJsObject());
            } catch (DownloadException error) {
                deleteQuietly(temporary);
                rejectWithStatus(call, error);
            } catch (Exception error) {
                deleteQuietly(temporary);
                call.reject(safeErrorMessage(error, "无法下载并保存图片"));
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    /**
     * Issues one provider request and persists its resulting image before the
     * response can cross the WebView bridge. This operation intentionally has
     * no fallback/retry: a retry could create a second billable generation.
     */
    @PluginMethod
    public void generate(PluginCall call) {
        String endpoint = call.getString("endpoint");
        String model = call.getString("model");
        String prompt = call.getString("prompt");
        String size = call.getString("size");
        String projectId = safeSegment(call.getString("projectId", ""));
        String assetId = safeSegment(call.getString("assetId", ""));
        String bearerToken = call.getString("bearerToken");
        JSArray referenceSources = call.getArray("referenceSources");
        String responseFormat = call.getString("responseFormat");
        if (isBlank(endpoint) || isBlank(model) || isBlank(prompt) || isBlank(size) || projectId.isEmpty() || assetId.isEmpty() || isBlank(bearerToken)) {
            call.reject("图片生成参数不完整");
            return;
        }

        getBridge().execute(() -> {
            long startedAt = System.currentTimeMillis();
            HttpURLConnection connection = null;
            File temporary = null;
            try {
                URL endpointUrl = new URL(endpoint);
                if (!isHttpUrl(endpointUrl)) throw new IOException("图片接口地址必须使用 HTTP 或 HTTPS");
                File directory = imageDirectory(projectId);
                ensureDirectory(directory);
                temporary = new File(directory, assetId + ".generation.tmp");
                connection = openGenerationConnection(endpointUrl, bearerToken);
                if (referenceSources != null && referenceSources.length() > 0) {
                    writeMultipartRequest(connection, model, prompt, size, responseFormat, referenceSources);
                } else {
                    writeGenerationJson(connection, model, prompt, size, responseFormat);
                }
                int status = connection.getResponseCode();
                // Generation requests are never manually retried or redirected.
                // A redirect could otherwise resend the provider Authorization
                // header to a different origin and create a second billed task.
                if (!isSuccessfulGenerationResponse(status)) throw new DownloadException("图片生成接口返回 HTTP " + status, status);
                JSONObject image = firstImage(readJsonBody(connection.getInputStream()));
                long responseAt = System.currentTimeMillis();

                String imageUrl = image.optString("url", "");
                String b64 = image.optString("b64_json", "");
                long bytes;
                String responseMode;
                if (!imageUrl.isEmpty()) {
                    URL resolvedImageUrl = new URL(endpointUrl, imageUrl);
                    HttpURLConnection imageConnection = null;
                    try {
                        String imageBearer = sameOrigin(endpointUrl, resolvedImageUrl) ? bearerToken : null;
                        imageConnection = openConnectionFollowingRedirects(resolvedImageUrl, imageBearer);
                        int imageStatus = imageConnection.getResponseCode();
                        if (imageStatus < 200 || imageStatus >= 300) throw new DownloadException("图片下载返回 HTTP " + imageStatus, imageStatus);
                        bytes = copyResponse(imageConnection.getInputStream(), temporary);
                    } finally {
                        if (imageConnection != null) imageConnection.disconnect();
                    }
                    responseMode = "url";
                } else if (!b64.isEmpty()) {
                    bytes = decodeBase64ToFile(b64, temporary);
                    responseMode = "b64_json";
                } else {
                    throw new IOException("图片模型没有返回 URL 或图片数据");
                }
                long writeAt = System.currentTimeMillis();
                StoredImage stored = finalizeImage(directory, temporary, assetId, bytes, responseAt - startedAt, writeAt - responseAt, startedAt);
                JSObject result = stored.toJsObject();
                result.put("responseMode", responseMode);
                call.resolve(result);
            } catch (DownloadException error) {
                deleteQuietly(temporary);
                rejectWithStatus(call, error);
            } catch (Exception error) {
                deleteQuietly(temporary);
                call.reject(safeErrorMessage(error, "无法生成并保存图片"));
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private File imageDirectory(String projectId) {
        return new File(getContext().getFilesDir(), "projects/" + projectId + "/images");
    }

    private static void ensureDirectory(File directory) throws IOException {
        if (!directory.exists() && !directory.mkdirs() && !directory.isDirectory()) throw new IOException("无法创建图片目录");
    }

    private static StoredImage finalizeImage(File directory, File temporary, String assetId, long bytes, long responseMs, long writeMs, long startedAt) throws IOException {
        long validationStartedAt = System.currentTimeMillis();
        String format = validateImage(temporary);
        if (format == null) throw new IOException("图片文件不完整或格式不受支持");
        File target = new File(directory, assetId + "." + format);
        replaceAtomically(temporary, target);
        removeOtherFormats(directory, assetId, format);
        long completedAt = System.currentTimeMillis();
        return new StoredImage(target, format, bytes, responseMs, writeMs, completedAt - validationStartedAt, completedAt - startedAt);
    }

    private static HttpURLConnection openGenerationConnection(URL url, String bearerToken) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(false);
        connection.setDoOutput(true);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Authorization", "Bearer " + bearerToken);
        return connection;
    }

    private static void writeGenerationJson(HttpURLConnection connection, String model, String prompt, String size, String responseFormat) throws IOException {
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        JSONObject request = new JSONObject();
        try {
            request.put("model", model);
            request.put("prompt", prompt);
            request.put("size", size);
            if ("b64_json".equals(responseFormat)) request.put("response_format", "b64_json");
        } catch (Exception error) {
            throw new IOException("无法准备图片生成请求", error);
        }
        try (OutputStream output = connection.getOutputStream()) {
            output.write(request.toString().getBytes(StandardCharsets.UTF_8));
        }
    }

    private void writeMultipartRequest(HttpURLConnection connection, String model, String prompt, String size, String responseFormat, JSArray referenceSources) throws IOException {
        String boundary = "----IllustratedStory" + UUID.randomUUID().toString().replace("-", "");
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        try (OutputStream output = new BufferedOutputStream(connection.getOutputStream())) {
            writeMultipartText(output, boundary, "model", model);
            writeMultipartText(output, boundary, "prompt", prompt);
            writeMultipartText(output, boundary, "size", size);
            if ("b64_json".equals(responseFormat)) writeMultipartText(output, boundary, "response_format", "b64_json");
            for (int index = 0; index < referenceSources.length(); index++) {
                String source = referenceSources.optString(index, "");
                if (source.isEmpty()) throw new IOException("参考图地址无效");
                writeMultipartImage(output, boundary, source, index + 1);
            }
            output.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.US_ASCII));
        }
    }

    private static void writeMultipartText(OutputStream output, String boundary, String name, String value) throws IOException {
        output.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        output.write(value.getBytes(StandardCharsets.UTF_8));
        output.write("\r\n".getBytes(StandardCharsets.US_ASCII));
    }

    private void writeMultipartImage(OutputStream output, String boundary, String source, int index) throws IOException {
        String contentType = referenceContentType(source);
        output.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"image\"; filename=\"reference-" + index + "." + extensionForContentType(contentType) + "\"\r\nContent-Type: " + contentType + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        try (InputStream input = openReferenceImage(source)) {
            copy(input, output);
        }
        output.write("\r\n".getBytes(StandardCharsets.US_ASCII));
    }

    private InputStream openReferenceImage(String source) throws IOException {
        if (source.startsWith("data:")) return openDataUrl(source);
        Uri uri = Uri.parse(source);
        if ("file".equalsIgnoreCase(uri.getScheme())) return openTrustedReferenceFile(new File(uri.getPath()));
        File capacitorFile = localCapacitorFile(source);
        if (capacitorFile != null) return openTrustedReferenceFile(capacitorFile);
        URL remoteUrl = new URL(source);
        if (!isHttpUrl(remoteUrl)) throw new IOException("参考图地址无效");
        HttpURLConnection connection = openConnectionFollowingRedirects(remoteUrl, null);
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            connection.disconnect();
            throw new DownloadException("参考图下载返回 HTTP " + status, status);
        }
        return new DisconnectingInputStream(new BufferedInputStream(connection.getInputStream()), connection);
    }

    private InputStream openTrustedReferenceFile(File file) throws IOException {
        File canonical = file.getCanonicalFile();
        if (!isWithinAppStorage(canonical)) throw new IOException("参考图不在应用私有存储中");
        return new BufferedInputStream(new FileInputStream(canonical));
    }

    private boolean isWithinAppStorage(File candidate) throws IOException {
        return isWithin(candidate, getContext().getFilesDir())
            || isWithin(candidate, getContext().getCacheDir())
            || isWithin(candidate, getContext().getNoBackupFilesDir());
    }

    private static boolean isWithin(File candidate, File root) throws IOException {
        String rootPath = root.getCanonicalPath();
        String candidatePath = candidate.getCanonicalPath();
        return candidatePath.equals(rootPath) || candidatePath.startsWith(rootPath + File.separator);
    }

    private static String referenceContentType(String source) {
        if (source.startsWith("data:")) {
            int semicolon = source.indexOf(';');
            if (semicolon > 5) {
                String type = source.substring(5, semicolon).toLowerCase();
                if (type.startsWith("image/")) return type;
            }
        }
        String type = URLConnection.guessContentTypeFromName(source);
        return type != null && type.startsWith("image/") ? type : "image/png";
    }

    private static String extensionForContentType(String contentType) {
        if ("image/jpeg".equals(contentType)) return "jpg";
        if ("image/webp".equals(contentType)) return "webp";
        if ("image/gif".equals(contentType)) return "gif";
        if ("image/avif".equals(contentType)) return "avif";
        if ("image/heic".equals(contentType) || "image/heif".equals(contentType)) return "heic";
        return "png";
    }

    private static InputStream openDataUrl(String source) throws IOException {
        int comma = source.indexOf(',');
        if (comma < 0 || !source.substring(0, comma).toLowerCase().contains(";base64")) throw new IOException("参考图数据格式不正确");
        return new Base64InputStream(new ByteArrayInputStream(source.substring(comma + 1).getBytes(StandardCharsets.US_ASCII)), Base64.DEFAULT);
    }

    static File localCapacitorFile(String source) {
        int marker = source.indexOf("/_capacitor_file_");
        if (marker < 0) return null;
        String encodedPath = source.substring(marker + "/_capacitor_file_".length());
        try {
            String path = URLDecoder.decode(encodedPath, StandardCharsets.UTF_8.name());
            return path.startsWith("/") ? new File(path) : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static JSONObject firstImage(String response) throws IOException {
        try {
            JSONObject root = new JSONObject(response);
            JSONArray data = root.optJSONArray("data");
            if (data == null || data.length() == 0 || !(data.opt(0) instanceof JSONObject)) throw new IOException("图片模型没有返回图片结果");
            return data.getJSONObject(0);
        } catch (IOException error) {
            throw error;
        } catch (Exception error) {
            throw new IOException("图片模型返回格式无效", error);
        }
    }

    private static String readJsonBody(InputStream input) throws IOException {
        try (InputStream buffered = new BufferedInputStream(input)) {
            byte[] buffer = new byte[COPY_BUFFER_BYTES];
            StringBuilder body = new StringBuilder();
            int total = 0;
            int read;
            while ((read = buffered.read(buffer)) >= 0) {
                if (read == 0) continue;
                total += read;
                if (total > MAX_GENERATION_RESPONSE_BYTES) throw new IOException("图片生成响应过大");
                body.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
            }
            return body.toString();
        }
    }

    private static long decodeBase64ToFile(String base64, File temporary) throws IOException {
        try (InputStream input = new Base64InputStream(new ByteArrayInputStream(base64.getBytes(StandardCharsets.US_ASCII)), Base64.DEFAULT);
             BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(temporary, false))) {
            return copy(input, output);
        } catch (IllegalArgumentException error) {
            throw new IOException("图片 Base64 数据无效", error);
        }
    }

    private static HttpURLConnection openConnectionFollowingRedirects(URL initialUrl, String bearerToken) throws IOException {
        URL currentUrl = initialUrl;
        boolean authorizationAllowed = bearerToken != null && !bearerToken.isEmpty();
        for (int redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
            HttpURLConnection connection = (HttpURLConnection) currentUrl.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "image/*");
            if (authorizationAllowed) connection.setRequestProperty("Authorization", "Bearer " + bearerToken);
            int status = connection.getResponseCode();
            if (!isRedirect(status)) return connection;
            String location = connection.getHeaderField("Location");
            connection.disconnect();
            if (isBlank(location)) throw new IOException("图片下载重定向缺少目标地址");
            if (redirectCount == MAX_REDIRECTS) throw new IOException("图片下载重定向次数过多");
            URL nextUrl = new URL(currentUrl, location);
            // Once a redirect leaves the original origin, credentials remain
            // disabled even if a later redirect returns to that origin.
            authorizationAllowed = authorizationAllowed && sameOrigin(initialUrl, nextUrl);
            currentUrl = nextUrl;
        }
        throw new IOException("图片下载重定向次数过多");
    }

    static boolean sameOrigin(URL left, URL right) {
        return left.getProtocol().equalsIgnoreCase(right.getProtocol())
            && left.getHost().equalsIgnoreCase(right.getHost())
            && effectivePort(left) == effectivePort(right);
    }

    private static int effectivePort(URL url) {
        return url.getPort() >= 0 ? url.getPort() : url.getDefaultPort();
    }

    private static boolean isHttpUrl(URL url) {
        return "http".equalsIgnoreCase(url.getProtocol()) || "https".equalsIgnoreCase(url.getProtocol());
    }

    private static boolean isRedirect(int status) {
        return status == HttpURLConnection.HTTP_MOVED_PERM || status == HttpURLConnection.HTTP_MOVED_TEMP
            || status == HttpURLConnection.HTTP_SEE_OTHER || status == 307 || status == 308;
    }

    static boolean isSuccessfulGenerationResponse(int status) {
        return status >= 200 && status < 300;
    }

    private static long copyResponse(InputStream input, File temporary) throws IOException {
        try (InputStream buffered = new BufferedInputStream(input);
             BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(temporary, false))) {
            return copy(buffered, output);
        }
    }

    private static long copy(InputStream input, OutputStream output) throws IOException {
        long total = 0;
        byte[] buffer = new byte[COPY_BUFFER_BYTES];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            if (read == 0) continue;
            output.write(buffer, 0, read);
            total += read;
        }
        output.flush();
        return total;
    }

    private static String validateImage(File file) throws IOException {
        if (!file.isFile() || file.length() < 12) return null;
        byte[] head = new byte[(int) Math.min(64, file.length())];
        byte[] tail = new byte[(int) Math.min(64, file.length())];
        try (FileInputStream input = new FileInputStream(file)) {
            if (input.read(head) != head.length) return null;
            long tailOffset = Math.max(0, file.length() - tail.length);
            if (input.getChannel().position(tailOffset).position() != tailOffset) return null;
            if (input.read(tail) != tail.length) return null;
        }
        if (startsWith(head, new int[]{137, 80, 78, 71, 13, 10, 26, 10})) return endsWith(tail, new int[]{73, 69, 78, 68, 174, 66, 96, 130}) ? "png" : null;
        if (startsWith(head, new int[]{255, 216, 255})) return endsWith(tail, new int[]{255, 217}) ? "jpg" : null;
        if (startsWith(head, new int[]{71, 73, 70, 56})) return endsWith(tail, new int[]{59}) ? "gif" : null;
        if (startsWith(head, new int[]{82, 73, 70, 70}) && ascii(head, 8, 4).equals("WEBP")) return unsignedLittleEndianInt(head, 4) + 8 == file.length() ? "webp" : null;
        if (ascii(head, 4, 4).equals("ftyp")) {
            String brand = ascii(head, 8, 4);
            if (brand.equals("avif") || brand.equals("avis")) return "avif";
            if (brand.equals("heic") || brand.equals("heix") || brand.equals("heim") || brand.equals("heis") || brand.equals("hevc") || brand.equals("hevx") || brand.equals("mif1") || brand.equals("msf1")) return "heic";
        }
        return null;
    }

    private static void replaceAtomically(File temporary, File target) throws IOException {
        File backup = new File(temporary.getParentFile(), temporary.getName() + ".previous");
        deleteQuietly(backup);
        if (target.exists() && !target.renameTo(backup)) throw new IOException("无法备份现有图片");
        if (!temporary.renameTo(target)) {
            if (backup.exists()) backup.renameTo(target);
            throw new IOException("无法替换现有图片");
        }
        deleteQuietly(backup);
    }

    private static void removeOtherFormats(File directory, String assetId, String retainedFormat) {
        for (String extension : IMAGE_EXTENSIONS) if (!extension.equals(retainedFormat)) deleteQuietly(new File(directory, assetId + "." + extension));
    }

    static boolean isSiblingImageFormat(String fileName, String assetId, String retainedFormat) {
        for (String extension : IMAGE_EXTENSIONS) if (!extension.equals(retainedFormat) && fileName.equals(assetId + "." + extension)) return true;
        return false;
    }

    private static boolean startsWith(byte[] bytes, int[] signature) {
        if (bytes.length < signature.length) return false;
        for (int index = 0; index < signature.length; index++) if ((bytes[index] & 0xff) != signature[index]) return false;
        return true;
    }

    private static boolean endsWith(byte[] bytes, int[] signature) {
        if (bytes.length < signature.length) return false;
        int offset = bytes.length - signature.length;
        for (int index = 0; index < signature.length; index++) if ((bytes[offset + index] & 0xff) != signature[index]) return false;
        return true;
    }

    private static String ascii(byte[] bytes, int offset, int length) {
        return offset + length > bytes.length ? "" : new String(bytes, offset, length, StandardCharsets.US_ASCII);
    }

    private static long unsignedLittleEndianInt(byte[] bytes, int offset) {
        return ((long) bytes[offset] & 0xff) | (((long) bytes[offset + 1] & 0xff) << 8) | (((long) bytes[offset + 2] & 0xff) << 16) | (((long) bytes[offset + 3] & 0xff) << 24);
    }

    private static String safeSegment(String value) { return value == null ? "" : value.replaceAll("[^a-zA-Z0-9_-]", "_"); }
    private static boolean isBlank(String value) { return value == null || value.trim().isEmpty(); }
    private static void deleteQuietly(File file) { if (file != null && file.exists()) file.delete(); }
    static String safeErrorMessage(Exception error, String fallback) {
        String message = error.getMessage();
        if (isBlank(message)) return fallback;
        String[] safePrefixes = {
            "图片接口地址必须使用", "图片模型没有返回", "无法创建图片目录", "图片文件不完整或格式不受支持",
            "无法准备图片生成请求", "参考图地址无效", "参考图下载返回 HTTP ", "参考图不在应用私有存储中",
            "参考图数据格式不正确", "图片模型返回格式无效", "图片生成响应过大", "图片 Base64 数据无效",
            "图片下载重定向", "无法备份现有图片", "无法替换现有图片"
        };
        for (String prefix : safePrefixes) if (message.startsWith(prefix)) return message;
        return fallback;
    }

    private static void rejectWithStatus(PluginCall call, DownloadException error) {
        JSObject details = new JSObject();
        details.put("status", error.status);
        call.reject(error.getMessage(), null, null, details);
    }

    private static class DownloadException extends IOException {
        final int status;
        DownloadException(String message, int status) { super(message); this.status = status; }
    }

    private static class StoredImage {
        final File file; final String format; final long bytes; final long responseMs; final long writeMs; final long validationAndReplaceMs; final long durationMs;
        StoredImage(File file, String format, long bytes, long responseMs, long writeMs, long validationAndReplaceMs, long durationMs) {
            this.file = file; this.format = format; this.bytes = bytes; this.responseMs = responseMs; this.writeMs = writeMs; this.validationAndReplaceMs = validationAndReplaceMs; this.durationMs = durationMs;
        }
        JSObject toJsObject() {
            JSObject result = new JSObject();
            result.put("localUri", Uri.fromFile(file).toString()); result.put("format", format); result.put("bytes", bytes);
            result.put("responseMs", responseMs); result.put("writeMs", writeMs); result.put("validationAndReplaceMs", validationAndReplaceMs); result.put("durationMs", durationMs);
            return result;
        }
    }

    private static class DisconnectingInputStream extends InputStream {
        private final InputStream input; private final HttpURLConnection connection;
        DisconnectingInputStream(InputStream input, HttpURLConnection connection) { this.input = input; this.connection = connection; }
        @Override public int read() throws IOException { return input.read(); }
        @Override public int read(byte[] buffer, int offset, int length) throws IOException { return input.read(buffer, offset, length); }
        @Override public void close() throws IOException { try { input.close(); } finally { connection.disconnect(); } }
    }
}
