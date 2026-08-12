package com.illustratedstory.app;

import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "ImageAssetStore")
public class ImageAssetStorePlugin extends Plugin {
    private static final int CONNECT_TIMEOUT_MS = 30_000;
    private static final int READ_TIMEOUT_MS = 120_000;
    private static final int COPY_BUFFER_BYTES = 64 * 1024;
    private static final int MAX_REDIRECTS = 5;
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
            File directory = new File(getContext().getFilesDir(), "projects/" + projectId + "/images");
            File temporary = new File(directory, assetId + ".download.tmp");
            HttpURLConnection connection = null;
            try {
                if (!directory.exists() && !directory.mkdirs() && !directory.isDirectory()) {
                    throw new IOException("无法创建图片目录");
                }
                connection = openConnectionFollowingRedirects(new URL(sourceUrl), bearerToken);
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    throw new DownloadException("图片下载返回 HTTP " + status, status);
                }

                long responseAt = System.currentTimeMillis();
                long bytes = copyResponse(connection, temporary);
                long writeAt = System.currentTimeMillis();
                String format = validateImage(temporary);
                if (format == null) throw new IOException("图片文件不完整或格式不受支持");
                File target = new File(directory, assetId + "." + format);
                replaceAtomically(temporary, target);
                removeOtherFormats(directory, assetId, format);
                long completedAt = System.currentTimeMillis();

                JSObject result = new JSObject();
                result.put("localUri", Uri.fromFile(target).toString());
                result.put("format", format);
                result.put("bytes", bytes);
                result.put("responseMs", responseAt - startedAt);
                result.put("writeMs", writeAt - responseAt);
                result.put("validationAndReplaceMs", completedAt - writeAt);
                result.put("durationMs", completedAt - startedAt);
                call.resolve(result);
            } catch (DownloadException error) {
                deleteQuietly(temporary);
                JSObject details = new JSObject();
                details.put("status", error.status);
                call.reject(error.getMessage(), null, error, details);
            } catch (Exception error) {
                deleteQuietly(temporary);
                call.reject(error.getMessage() == null ? "无法下载并保存图片" : error.getMessage(), null, error);
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
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
            if (location == null || location.isEmpty()) throw new IOException("图片下载重定向缺少目标地址");
            if (redirectCount == MAX_REDIRECTS) throw new IOException("图片下载重定向次数过多");
            URL nextUrl = new URL(currentUrl, location);
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

    private static boolean isRedirect(int status) {
        return status == HttpURLConnection.HTTP_MOVED_PERM
            || status == HttpURLConnection.HTTP_MOVED_TEMP
            || status == HttpURLConnection.HTTP_SEE_OTHER
            || status == 307
            || status == 308;
    }

    private static long copyResponse(HttpURLConnection connection, File temporary) throws IOException {
        long total = 0;
        try (BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
             BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(temporary, false))) {
            byte[] buffer = new byte[COPY_BUFFER_BYTES];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read == 0) continue;
                output.write(buffer, 0, read);
                total += read;
            }
            output.flush();
        }
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
        if (startsWith(head, new int[]{137, 80, 78, 71, 13, 10, 26, 10})) {
            return endsWith(tail, new int[]{73, 69, 78, 68, 174, 66, 96, 130}) ? "png" : null;
        }
        if (startsWith(head, new int[]{255, 216, 255})) {
            return endsWith(tail, new int[]{255, 217}) ? "jpg" : null;
        }
        if (startsWith(head, new int[]{71, 73, 70, 56})) {
            return endsWith(tail, new int[]{59}) ? "gif" : null;
        }
        if (startsWith(head, new int[]{82, 73, 70, 70}) && ascii(head, 8, 4).equals("WEBP")) {
            long declaredSize = unsignedLittleEndianInt(head, 4) + 8;
            return declaredSize == file.length() ? "webp" : null;
        }
        if (ascii(head, 4, 4).equals("ftyp")) {
            String brand = ascii(head, 8, 4);
            if (brand.equals("avif") || brand.equals("avis")) return "avif";
            if (brand.equals("heic") || brand.equals("heix") || brand.equals("heim") || brand.equals("heis")
                || brand.equals("hevc") || brand.equals("hevx") || brand.equals("mif1") || brand.equals("msf1")) return "heic";
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
        for (String extension : IMAGE_EXTENSIONS) {
            if (!extension.equals(retainedFormat)) deleteQuietly(new File(directory, assetId + "." + extension));
        }
    }

    static boolean isSiblingImageFormat(String fileName, String assetId, String retainedFormat) {
        for (String extension : IMAGE_EXTENSIONS) {
            if (!extension.equals(retainedFormat) && fileName.equals(assetId + "." + extension)) return true;
        }
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
        if (offset + length > bytes.length) return "";
        return new String(bytes, offset, length, StandardCharsets.US_ASCII);
    }

    private static long unsignedLittleEndianInt(byte[] bytes, int offset) {
        return ((long) bytes[offset] & 0xff)
            | (((long) bytes[offset + 1] & 0xff) << 8)
            | (((long) bytes[offset + 2] & 0xff) << 16)
            | (((long) bytes[offset + 3] & 0xff) << 24);
    }

    private static String safeSegment(String value) {
        return value == null ? "" : value.replaceAll("[^a-zA-Z0-9_-]", "_");
    }

    private static void deleteQuietly(File file) {
        if (file.exists()) file.delete();
    }

    private static class DownloadException extends IOException {
        final int status;
        DownloadException(String message, int status) {
            super(message);
            this.status = status;
        }
    }
}
