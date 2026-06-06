# Iris Flowers Dataset Statistical Summary

## Dataset Overview
- **Total rows**: 150
- **Total columns**: 5
- **Species distribution**:
  - setosa: 50 samples
  - versicolor: 50 samples
  - virginica: 50 samples

## Overall Statistics
| Statistic | SepalLength | SepalWidth | PetalLength | PetalWidth |
|-----------|-------------|------------|-------------|------------|
| Mean      | 5.843 | 3.057 | 3.758 | 1.199 |
| Median    | 5.800 | 3.000 | 4.350 | 1.300 |
| Std Dev   | 0.828 | 0.436 | 1.765 | 0.762 |
| Min       | 4.300 | 2.000 | 1.000 | 0.100 |
| Max       | 7.900 | 4.400 | 6.900 | 2.500 |

## Per-Species Statistics
### Setosa
| Statistic | SepalLength | SepalWidth | PetalLength | PetalWidth |
|-----------|-------------|------------|-------------|------------|
| Mean      | 5.006 | 3.428 | 1.462 | 0.246 |
| Std Dev   | 0.352 | 0.379 | 0.174 | 0.105 |

### Versicolor
| Statistic | SepalLength | SepalWidth | PetalLength | PetalWidth |
|-----------|-------------|------------|-------------|------------|
| Mean      | 5.936 | 2.770 | 4.260 | 1.326 |
| Std Dev   | 0.516 | 0.314 | 0.470 | 0.198 |

### Virginica
| Statistic | SepalLength | SepalWidth | PetalLength | PetalWidth |
|-----------|-------------|------------|-------------|------------|
| Mean      | 6.588 | 2.974 | 5.552 | 2.026 |
| Std Dev   | 0.636 | 0.322 | 0.552 | 0.275 |

## Correlation Insight
The strongest linear correlation is between **PetalLength** and **PetalWidth** with a correlation coefficient of **0.963**.

This strong positive correlation suggests that as PetalLength increases, PetalWidth tends to increase proportionally. This is particularly evident in the Iris dataset where petal dimensions are highly correlated, indicating that flower petal size tends to scale proportionally.

## Key Findings
1. **Species differentiation**: Setosa has distinctly smaller petals compared to versicolor and virginica, making it easily separable from the other species.
2. **Petal measurements**: Petal length and width show the most variation between species, with virginica having the largest petals and setosa the smallest.
3. **Sepal characteristics**: Sepal width is relatively consistent across species, while sepal length increases from setosa to virginica.
4. **Measurement ranges**: Petal measurements show the widest range (0.1-6.9 for length, 0.1-2.5 for width), while sepal measurements are more constrained.
5. **Correlation patterns**: Petal dimensions are highly correlated (r ≈ 0.963), suggesting they develop proportionally, while sepal dimensions show weaker correlations with petal measurements.
6. **Species overlap**: Versicolor and virginica show some overlap in measurements, particularly in sepal dimensions, while setosa is clearly distinct in petal measurements.

---
*Report generated on: 2026-06-01 14:46:37*
