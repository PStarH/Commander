import random
from collections import Counter

def simulate_game(num_balls=100):
    ramp = list(range(1, num_balls + 1))
    platform = []
    ejected_balls = []
    for _ in range(3):
        platform.append(ramp.pop(0))
    while len(platform) > 0:
        piston = random.randint(0, 2)
        if piston == 0:
            ejected = platform.pop(0)
            ejected_balls.append(ejected)
            if len(ramp) > 0:
                platform.append(ramp.pop(0))
        elif piston == 1:
            ejected = platform.pop(1)
            ejected_balls.append(ejected)
            platform.pop(0)
            for _ in range(2):
                if len(ramp) > 0:
                    platform.append(ramp.pop(0))
        elif piston == 2:
            ejected = platform.pop(2)
            ejected_balls.append(ejected)
            platform.pop(0)
            for _ in range(2):
                if len(ramp) > 0:
                    platform.append(ramp.pop(0))
    return ejected_balls

random.seed(42)
num_sims = 50000
ejection_counts = Counter()
for _ in range(num_sims):
    ejected = simulate_game(100)
    for ball in ejected:
        ejection_counts[ball] += 1

print('Top 30 most ejected balls:')
for ball, count in ejection_counts.most_common(30):
    pct = count / num_sims * 100
    print(f'Ball {ball}: ejected {count} times ({pct:.4f}%)')

print()
print(f'Total simulations: {num_sims}')
print(f'Total unique balls ejected: {len(ejection_counts)}')
missing = set(range(1, 101)) - set(ejection_counts.keys())
print(f'Missing balls (never ejected): {sorted(missing)}')
