package ar.com.asisto.mecan;
import org.junit.Test;
import static org.junit.Assert.*;

public class InstallRecoveryStateTest {
    @Test public void lateTicketStillArrivesAfterHomeAndOnlyOnce() {
        InstallRecoveryState state = new InstallRecoveryState();
        assertTrue(state.showHome());
        assertFalse(state.showHome());
        assertTrue(state.deliver("ticket-A", null));
        assertFalse(state.deliver("ticket-A", null));
        assertFalse(state.showHome());
    }
    @Test public void emptyResponsesDoNotConsumeRecovery() {
        InstallRecoveryState state = new InstallRecoveryState();
        assertFalse(state.deliver(null, null));
        assertTrue(state.showHome());
        assertFalse(state.deliver(null, null));
        assertTrue(state.deliver("ticket-A", null));
    }
    @Test public void completedTicketDoesNotReopenButNewOneCanArrive() {
        InstallRecoveryState state = new InstallRecoveryState();
        assertFalse(state.deliver("ticket-A", "ticket-A"));
        assertTrue(state.deliver("ticket-B", "ticket-A"));
        assertFalse(state.showHome());
    }
}
