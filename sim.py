import random

def simulate_game(ball_pick, num_sims=100000):
    wins = 0
    for _ in range(num_sims):
        ramp = list(range(4, 101))
        platform = [1, 2, 3]
        ri = 0  # ramp index
        while True:
            # Check if game should end
            if platform[0] is None and platform[1] is None and platform[2] is None:
                break
            if all(b is None for b in platform):
                break
                
            piston = random.randint(0, 2)
            
            if piston == 0:  # Eject pos 1
                ejected = platform[0]
                if ejected == ball_pick:
                    wins += 1
                    break
                platform[0] = platform[1]
                platform[1] = platform[2]
                if ri < len(ramp):
                    platform[2] = ramp[ri]
                    ri += 1
                else:
                    platform[2] = None
            elif piston == 1:  # Eject pos 2
                ejected = platform[1]
                if ejected == ball_pick:
                    wins += 1
                    break
                # pos 1 released (gone), pos 3 -> pos 1
                platform[0] = platform[2]
                if ri < len(ramp):
                    platform[1] = ramp[ri]
                    ri += 1
                else:
                    platform[1] = None
                if ri < len(ramp):
                    platform[2] = ramp[ri]
                    ri += 1
                else:
                    platform[2] = None
            else:  # Eject pos 3
                ejected = platform[2]
                if ejected == ball_pick:
                    wins += 1
                    break
                # pos 1 released (gone), pos 2 -> pos 1
                platform[0] = platform[1]
                if ri < len(ramp):
                    platform[1] = ramp[ri]
                    ri += 1
                else:
                    platform[1] = None
                if ri < len(ramp):
                    platform[2] = ramp[ri]
                    ri += 1
                else:
                    platform[2] = None
            
            # End game if not enough balls
            if platform[0] is None or platform[1] is None or platform[2] is None:
                break
    return wins / num_sims

# Quick test
import sys
results = {}
for b in range(1, 101):
    results[b] = simulate_game(b, 20000)

best = max(results, key=results.get)
sys.stderr.write(f"Best ball: {best} with prob {results[best]:.6f}\n")
sorted_r = sorted(results.items(), key=lambda x: x[1], reverse=True)
for b, p in sorted_r[:20]:
    sys.stderr.write(f"Ball {b}: {p:.6f}\n")
sys.stderr.flush()
