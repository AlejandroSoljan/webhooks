package ar.com.asisto.mecan;

/** Showing Home must not discard a late installation ticket. */
final class InstallRecoveryState {
    private boolean homeShown, delivered;
    boolean showHome() {
        if (homeShown || delivered) return false;
        homeShown = true;
        return true;
    }
    boolean deliver(String url, String completed) {
        if (delivered || url == null || url.equals(completed)) return false;
        delivered = true;
        return true;
    }
}
