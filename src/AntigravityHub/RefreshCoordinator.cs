using System;
using System.Threading.Tasks;

namespace AntigravityHub
{
    internal sealed record RefreshOutcome(bool Success, string Message);

    // Requests made while a refresh runs await its real result instead of receiving fake completion.
    internal sealed class RefreshCoordinator
    {
        private readonly object _gate = new();
        private Task<RefreshOutcome>? _running;
        public Task<RefreshOutcome> RunAsync(Func<Task<RefreshOutcome>> operation)
        {
            lock (_gate)
            {
                if (_running == null || _running.IsCompleted) _running = Task.Run(operation);
                return _running;
            }
        }
    }
}
