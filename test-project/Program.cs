namespace TestProject;

/// <summary>测试用接口</summary>
public interface IAnimal
{
    string Name { get; }
    void Speak();
}

/// <summary>测试用类</summary>
public class Dog : IAnimal
{
    public string Name { get; }

    public Dog(string name) => Name = name;

    public void Speak() => Console.WriteLine("Woof!");
}

public class Program
{
    public static void Main()
    {
        var dog = new Dog("Rex");
        dog.Speak();
    }
}
